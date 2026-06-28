import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';
import {
  attachVolume,
  createVolume,
  deleteVolume,
  detachVolume,
  makeHetznerVolumeManager,
  setProtection,
  VolumeFailed,
} from './hetzner-volume.ts';

/**
 * Hetzner volume manager — unit tests over the thin fetch helpers and the
 * Effect factory. No network: `globalThis.fetch` is swapped for a fake that
 * captures the request shape and returns canned responses (same idiom as
 * hetzner-box.test.ts).
 */

/** Swap in a fake fetch for the duration of `body`, capturing the request. */
const withFetch = async (
  handler: (url: string, init?: RequestInit) => Response,
  capture: { url?: string; method?: string; body?: unknown },
  body: () => Promise<void>,
): Promise<void> => {
  const orig = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      capture.url = String(url);
      capture.method = init?.method;
      capture.body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      return handler(String(url), init);
    },
    { preconnect: () => {} },
  ) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = orig;
  }
};

const ok = (payload: unknown, status = 201): Response =>
  new Response(JSON.stringify(payload), { status });

describe('createVolume', () => {
  it('POSTs to /volumes and parses volumeId + linuxDevice', async () => {
    const cap: { url?: string; method?: string; body?: unknown } = {};
    let result: { volumeId: number; linuxDevice: string } | undefined;
    await withFetch(
      () =>
        ok({
          volume: { id: 4711, linux_device: '/dev/disk/by-id/scsi-0HC_Volume_4711' },
          action: { id: 1, status: 'running' },
          next_actions: [],
        }),
      cap,
      async () => {
        result = await createVolume('tok', {
          name: 'tp-state-x',
          location: 'nbg1',
          size: 10,
          format: 'ext4',
          labels: { managed_by: 'tidepool', role: 'management-state' },
        });
      },
    );
    assert.equal(cap.url, 'https://api.hetzner.cloud/v1/volumes');
    assert.equal(cap.method, 'POST');
    assert.deepEqual(result, {
      volumeId: 4711,
      linuxDevice: '/dev/disk/by-id/scsi-0HC_Volume_4711',
    });
  });

  it('sends name/size/location/format in the request body', async () => {
    const cap: { url?: string; method?: string; body?: Record<string, unknown> } = {};
    await withFetch(
      () => ok({ volume: { id: 1, linux_device: '/dev/x' } }),
      cap,
      async () => {
        await createVolume('tok', {
          name: 'tp-state-x',
          location: 'fsn1',
          size: 20,
          format: 'ext4',
          labels: { role: 'management-state' },
        });
      },
    );
    const body = cap.body as Record<string, unknown>;
    assert.equal(body.name, 'tp-state-x');
    assert.equal(body.size, 20);
    assert.equal(body.location, 'fsn1');
    assert.equal(body.format, 'ext4');
  });

  it('forces managed_by=tidepool so the cleanup can always find it', async () => {
    const cap: { body?: { labels?: Record<string, string> } } = {};
    await withFetch(
      () => ok({ volume: { id: 1, linux_device: '/dev/x' } }),
      cap,
      async () => {
        // Caller tries to override managed_by — it must not win.
        await createVolume('tok', {
          name: 'n',
          location: 'nbg1',
          size: 10,
          format: 'ext4',
          labels: { managed_by: 'someone-else', role: 'management-state' },
        });
      },
    );
    assert.equal(cap.body?.labels?.managed_by, 'tidepool');
    assert.equal(cap.body?.labels?.role, 'management-state');
  });
});

describe('attachVolume', () => {
  it('POSTs server + automount to the attach action', async () => {
    const cap: { url?: string; method?: string; body?: Record<string, unknown> } = {};
    await withFetch(
      () => ok({ action: { id: 9, status: 'running', command: 'attach_volume' } }),
      cap,
      async () => {
        await attachVolume('tok', { volumeId: 4711, serverId: 42, automount: true });
      },
    );
    assert.equal(cap.url, 'https://api.hetzner.cloud/v1/volumes/4711/actions/attach');
    assert.equal(cap.method, 'POST');
    assert.equal(cap.body?.server, 42);
    assert.equal(cap.body?.automount, true);
  });
});

describe('detachVolume', () => {
  it('POSTs to the detach action', async () => {
    const cap: { url?: string; method?: string } = {};
    await withFetch(
      () => ok({ action: { id: 9, status: 'running', command: 'detach_volume' } }),
      cap,
      async () => {
        await detachVolume('tok', 4711);
      },
    );
    assert.equal(cap.url, 'https://api.hetzner.cloud/v1/volumes/4711/actions/detach');
    assert.equal(cap.method, 'POST');
  });
});

describe('deleteVolume', () => {
  it('DELETEs the volume (204 No Content)', async () => {
    const cap: { url?: string; method?: string } = {};
    await withFetch(
      () => new Response(null, { status: 204 }),
      cap,
      async () => {
        await deleteVolume('tok', 4711);
      },
    );
    assert.equal(cap.url, 'https://api.hetzner.cloud/v1/volumes/4711');
    assert.equal(cap.method, 'DELETE');
  });

  it('treats a 404 as already-gone (idempotent)', async () => {
    const cap: { url?: string } = {};
    await withFetch(
      () => new Response(null, { status: 404 }),
      cap,
      async () => {
        await deleteVolume('tok', 4711); // must not throw
      },
    );
    assert.equal(cap.url, 'https://api.hetzner.cloud/v1/volumes/4711');
  });
});

describe('setProtection', () => {
  it('POSTs the delete flag to change_protection', async () => {
    const cap: { url?: string; method?: string; body?: Record<string, unknown> } = {};
    await withFetch(
      () => ok({ action: { id: 9, status: 'running', command: 'change_protection' } }),
      cap,
      async () => {
        await setProtection('tok', 4711, { delete: true });
      },
    );
    assert.equal(cap.url, 'https://api.hetzner.cloud/v1/volumes/4711/actions/change_protection');
    assert.equal(cap.method, 'POST');
    assert.equal(cap.body?.delete, true);
  });
});

describe('makeHetznerVolumeManager', () => {
  it('maps a failed create response to VolumeFailed in the Effect channel', () =>
    Effect.gen(function* () {
      const mgr = makeHetznerVolumeManager('tok');
      const orig = globalThis.fetch;
      globalThis.fetch = Object.assign(
        async () =>
          new Response(JSON.stringify({ error: { code: 'forbidden', message: 'nope' } }), {
            status: 403,
          }),
        { preconnect: () => {} },
      ) as typeof fetch;

      const exit = yield* Effect.exit(
        mgr.create({
          name: 'n',
          location: 'nbg1',
          size: 10,
          format: 'ext4',
          labels: { role: 'management-state' },
        }),
      );

      globalThis.fetch = orig;

      assert.isTrue(exit._tag === 'Failure');
      if (exit._tag === 'Failure' && exit.cause._tag === 'Fail') {
        assert.instanceOf(exit.cause.error, VolumeFailed);
      }
    }).pipe(Effect.runPromise));

  it('returns the created volume through the Effect channel on success', () =>
    Effect.gen(function* () {
      const mgr = makeHetznerVolumeManager('tok');
      const orig = globalThis.fetch;
      globalThis.fetch = Object.assign(
        async () => ok({ volume: { id: 77, linux_device: '/dev/disk/by-id/scsi-0HC_Volume_77' } }),
        { preconnect: () => {} },
      ) as typeof fetch;

      const created = yield* mgr.create({
        name: 'n',
        location: 'nbg1',
        size: 10,
        format: 'ext4',
        labels: { role: 'management-state' },
      });

      globalThis.fetch = orig;

      assert.equal(created.volumeId, 77);
      assert.equal(created.linuxDevice, '/dev/disk/by-id/scsi-0HC_Volume_77');
    }).pipe(Effect.runPromise));
});
