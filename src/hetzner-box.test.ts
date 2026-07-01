import { FetchHttpClient, HttpClient } from '@effect/platform';
import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';
import {
  bakeRecipeCommands,
  createServer,
  createServerSnapshot,
  findWorkerSnapshot,
  getImageStatus,
  workerCloudInit,
  workerInstallScript,
} from './hetzner-box.ts';

/**
 * Hetzner box maker — unit tests over pure functions and the factory.
 * No real network: the HTTP helpers run on the real `@effect/platform` Fetch
 * client, but `globalThis.fetch` is stubbed per-test (FetchHttpClient resolves
 * the global at request time), so the wire layer is exercised against fakes.
 */

/**
 * Resolve the live `FetchHttpClient` and hand it to `f`, then run to a Promise.
 * Keeps each HTTP-helper test a one-liner over the stubbed `globalThis.fetch`.
 */
const withClient = <A, E>(f: (client: HttpClient.HttpClient) => Effect.Effect<A, E>): Promise<A> =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap(f),
    Effect.provide(FetchHttpClient.layer),
    Effect.runPromise,
  );

const FAKE_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA test@tidepool';

describe('workerCloudInit', () => {
  it('embeds the ssh public key', () => {
    const init = workerCloudInit(FAKE_KEY);
    assert.include(init, FAKE_KEY);
  });

  it('starts with #cloud-config marker', () => {
    assert.isTrue(workerCloudInit(FAKE_KEY).startsWith('#cloud-config'));
  });

  it('includes bun install runcmd', () => {
    assert.include(workerCloudInit(FAKE_KEY), 'bun.sh/install');
  });

  it('includes opencode sdk install', () => {
    assert.include(workerCloudInit(FAKE_KEY), '@opencode-ai/sdk');
  });

  it('inlines every command from the bake.sh recipe (no drift)', () => {
    const init = workerCloudInit(FAKE_KEY);
    const recipe = bakeRecipeCommands();
    assert.isAtLeast(recipe.length, 1, 'recipe should be non-empty');
    for (const cmd of recipe) {
      assert.include(init, cmd);
    }
  });

  it('appends the per-boot sentinel but keeps it OUT of the baked recipe', () => {
    assert.include(workerCloudInit(FAKE_KEY), 'touch /tmp/.tp-ready');
    assert.notInclude(bakeRecipeCommands().join('\n'), '.tp-ready');
  });
});

describe('workerCloudInit baked mode', () => {
  const baked = () => workerCloudInit(FAKE_KEY, { baked: true });

  it('starts with #cloud-config marker', () => {
    assert.isTrue(baked().startsWith('#cloud-config'));
  });

  it('embeds the ssh public key', () => {
    assert.include(baked(), FAKE_KEY);
  });

  it('still touches the per-boot sentinel (the runner polls it every boot)', () => {
    assert.include(baked(), 'touch /tmp/.tp-ready');
  });

  it('omits the bake recipe — everything is already in the image', () => {
    const init = baked();
    assert.notInclude(init, 'bun.sh/install');
    assert.notInclude(init, '@opencode-ai/sdk');
    // No apt install on a baked boot — the packages are already present.
    assert.notInclude(init, 'packages:');
  });

  it('keeps the runcmd quote-safe (no nested single quotes)', () => {
    // The full-mode `bash -c '...'` wrapper is the nested-quote hazard. The baked
    // runcmd is a bare command with no embedded quoting, so it can never mangle.
    assert.notInclude(baked(), "bash -c '");
  });
});

describe('workerInstallScript', () => {
  it('is the bake.sh recipe body verbatim (the harness runs identical steps)', () => {
    const script = workerInstallScript();
    // Every inlined command must appear in the byte-for-byte script the local
    // container harness executes, so "works in the harness" == "works on the box".
    for (const cmd of bakeRecipeCommands()) {
      assert.include(script, cmd);
    }
  });

  it('keeps the fail-fast shell header', () => {
    assert.include(workerInstallScript(), 'set -ex');
  });

  it('runs no command that touches the per-boot sentinel (boot appends it, not bake)', () => {
    assert.notInclude(bakeRecipeCommands().join('\n'), '.tp-ready');
  });
});

describe('worker snapshot image API', () => {
  it('findWorkerSnapshot returns the first managed worker snapshot', async () => {
    const origFetch = globalThis.fetch;
    let capturedUrl = '';
    globalThis.fetch = ((url: string | URL) => {
      capturedUrl = String(url);
      return Promise.resolve(
        new Response(JSON.stringify({ images: [{ id: 555, status: 'available' }] }), {
          status: 200,
        }),
      );
    }) as typeof fetch;

    const snap = await withClient((client) => findWorkerSnapshot(client, 'tok'));
    globalThis.fetch = origFetch;

    assert.deepEqual(snap, { id: 555, status: 'available' });
    assert.include(capturedUrl, 'type=snapshot');
    assert.include(capturedUrl, 'managed_by%3Dtidepool');
    assert.include(capturedUrl, 'role%3Dworker');
  });

  it('findWorkerSnapshot returns undefined when no snapshot exists', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = ((_url: string) =>
      Promise.resolve(
        new Response(JSON.stringify({ images: [] }), { status: 200 }),
      )) as typeof fetch;

    const snap = await withClient((client) => findWorkerSnapshot(client, 'tok'));
    globalThis.fetch = origFetch;

    assert.isUndefined(snap);
  });

  it('createServerSnapshot posts type=snapshot with managed_by + role labels', async () => {
    const origFetch = globalThis.fetch;
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = ((url: string | URL, init: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Promise.resolve(
        new Response(JSON.stringify({ image: { id: 777, status: 'creating' } }), { status: 201 }),
      );
    }) as typeof fetch;

    const imageId = await withClient((client) =>
      createServerSnapshot(client, 'tok', 42, 'tidepool worker'),
    );
    globalThis.fetch = origFetch;

    assert.equal(imageId, 777);
    assert.include(capturedUrl, '/servers/42/actions/create_image');
    assert.equal(capturedBody.type, 'snapshot');
    assert.deepEqual(capturedBody.labels, { managed_by: 'tidepool', role: 'worker' });
  });

  it('getImageStatus returns the image status', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = ((_url: string) =>
      Promise.resolve(
        new Response(JSON.stringify({ image: { id: 777, status: 'available' } }), { status: 200 }),
      )) as typeof fetch;

    const status = await withClient((client) => getImageStatus(client, 'tok', 777));
    globalThis.fetch = origFetch;

    assert.equal(status, 'available');
  });
});

describe('createServer labels', () => {
  it('applies caller labels alongside the non-overridable reaper labels', async () => {
    let captured: { labels?: Record<string, string> } = {};
    const origFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (_url: string | URL | Request, init?: RequestInit) => {
        captured = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({ server: { id: 1, public_net: { ipv4: { ip: '1.2.3.4' } } } }),
          { status: 201 },
        );
      },
      { preconnect: () => {} },
    ) as typeof fetch;

    await withClient((client) =>
      createServer(client, 'tok', {
        name: 'tp-worker-x',
        serverType: 'cpx22',
        location: 'nbg1',
        sshKeyId: 1,
        networkId: 2,
        userData: 'x',
        labels: { ticket: 'tckt_qt6tbzn900' },
      }),
    );

    globalThis.fetch = origFetch;

    assert.equal(captured.labels?.ticket, 'tckt_qt6tbzn900', 'caller ticket label applied');
    assert.equal(captured.labels?.managed_by, 'tidepool');
    assert.equal(captured.labels?.role, 'worker');
  });
});

describe('createServer image', () => {
  const fakeCreate = (capture: { value?: string | number }) =>
    Object.assign(
      async (_url: string | URL | Request, init?: RequestInit) => {
        capture.value = (JSON.parse(String(init?.body)) as { image: string | number }).image;
        return new Response(
          JSON.stringify({ server: { id: 1, public_net: { ipv4: { ip: '1.2.3.4' } } } }),
          { status: 201 },
        );
      },
      { preconnect: () => {} },
    ) as typeof fetch;

  const baseParams = {
    name: 'tp-worker-x',
    serverType: 'cpx22',
    location: 'nbg1',
    sshKeyId: 1,
    networkId: 2,
    userData: 'x',
  };

  it('defaults to ubuntu-24.04 when no image is given', async () => {
    const capture: { value?: string | number } = {};
    const origFetch = globalThis.fetch;
    globalThis.fetch = fakeCreate(capture);
    await withClient((client) => createServer(client, 'tok', baseParams));
    globalThis.fetch = origFetch;
    assert.equal(capture.value, 'ubuntu-24.04');
  });

  it('uses the provided image (snapshot id or name)', async () => {
    const capture: { value?: string | number } = {};
    const origFetch = globalThis.fetch;
    globalThis.fetch = fakeCreate(capture);
    await withClient((client) =>
      createServer(client, 'tok', { ...baseParams, image: 234_567_890 }),
    );
    globalThis.fetch = origFetch;
    assert.equal(capture.value, 234_567_890);
  });
});
