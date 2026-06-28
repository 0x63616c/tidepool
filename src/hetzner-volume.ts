import { Context, Data, Effect, Layer } from 'effect';
import { hcloudToken } from './hetzner-box.ts';

/**
 * Real Hetzner Volume manager. A management-state volume is the durable home for
 * the control-plane sqlite (see `runtime.ts` `dbPath`): attach it to the
 * management box at `/mnt/tidepool`, and the db survives a box rebuild
 * (create → delete → recreate the box, reattach the same volume). Mirrors
 * `hetzner-box.ts`: thin async helpers over `fetch`, an Effect factory behind a
 * narrow seam, typed `VolumeFailed` errors, and non-overridable
 * `managed_by=tidepool` labels so a reaper/cleanup can always find them.
 *
 * Tenet 7 (design for N, run minimal): the management box doesn't exist yet, so
 * this ships the seam + a verifiable volume lifecycle, not a box bring-up.
 */

const HCLOUD_API = 'https://api.hetzner.cloud/v1';

// ── Typed error (lives here: domain.ts is owned by another lane) ──────────────

/** A Hetzner volume operation failed (auth, capacity, network, 5xx). */
export class VolumeFailed extends Data.TaggedError('VolumeFailed')<{
  readonly reason: string;
}> {}

// ── Hetzner API types ─────────────────────────────────────────────────────────

interface HcloudVolumeCreated {
  readonly volume: { readonly id: number; readonly linux_device: string };
  readonly error?: { readonly code: string; readonly message: string };
}

interface HcloudActionResponse {
  readonly error?: { readonly code: string; readonly message: string };
}

const hcloudHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

/** POST a volume action and surface any hcloud error as a thrown Error. */
const postAction = async (
  token: string,
  volumeId: number,
  action: string,
  body: Record<string, unknown>,
): Promise<void> => {
  const res = await fetch(`${HCLOUD_API}/volumes/${volumeId}/actions/${action}`, {
    method: 'POST',
    headers: hcloudHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as HcloudActionResponse;
    throw new Error(
      `hcloud ${action} volume ${volumeId} → ${res.status}: ${payload.error?.message ?? 'unknown'}`,
    );
  }
};

// ── Thin fetch helpers (mirror createServer/deleteServer in hetzner-box.ts) ────

/**
 * Create an unattached volume in `location`. `managed_by=tidepool` is forced
 * (never overridable) so cleanup can always select tidepool-owned volumes.
 * Returns the new id and its stable `linux_device` mount path.
 */
export const createVolume = async (
  token: string,
  params: {
    readonly name: string;
    readonly location: string;
    /** Size in GiB (Hetzner minimum is 10). */
    readonly size: number;
    readonly format: 'ext4' | 'xfs';
    readonly labels?: Record<string, string>;
  },
): Promise<{ readonly volumeId: number; readonly linuxDevice: string }> => {
  const res = await fetch(`${HCLOUD_API}/volumes`, {
    method: 'POST',
    headers: hcloudHeaders(token),
    body: JSON.stringify({
      name: params.name,
      size: params.size,
      location: params.location,
      format: params.format,
      // Caller labels first, then the non-overridable cleanup-critical label.
      labels: { ...params.labels, managed_by: 'tidepool' },
    }),
  });
  const body = (await res.json()) as HcloudVolumeCreated;
  if (!res.ok) {
    throw new Error(`hcloud createVolume ${res.status}: ${body.error?.message ?? 'unknown'}`);
  }
  return { volumeId: body.volume.id, linuxDevice: body.volume.linux_device };
};

/** Attach a volume to a server. `automount` mounts it on the box automatically. */
export const attachVolume = async (
  token: string,
  params: { readonly volumeId: number; readonly serverId: number; readonly automount: boolean },
): Promise<void> =>
  postAction(token, params.volumeId, 'attach', {
    server: params.serverId,
    automount: params.automount,
  });

/** Detach a volume from whatever server it is attached to. */
export const detachVolume = async (token: string, volumeId: number): Promise<void> =>
  postAction(token, volumeId, 'detach', {});

/** Toggle delete-protection on a volume (must be cleared before deleting). */
export const setProtection = async (
  token: string,
  volumeId: number,
  opts: { readonly delete: boolean },
): Promise<void> => postAction(token, volumeId, 'change_protection', { delete: opts.delete });

/** Delete a volume. A 404 is treated as already-gone (idempotent cleanup). */
export const deleteVolume = async (token: string, volumeId: number): Promise<void> => {
  const res = await fetch(`${HCLOUD_API}/volumes/${volumeId}`, {
    method: 'DELETE',
    headers: hcloudHeaders(token),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`hcloud deleteVolume ${volumeId} → ${res.status}`);
  }
};

// ── Narrow Effect seam ────────────────────────────────────────────────────────

export interface VolumeSpec {
  readonly name: string;
  readonly location: string;
  readonly size: number;
  readonly format: 'ext4' | 'xfs';
  readonly labels?: Record<string, string>;
}

/** The deep module's narrow front: volume lifecycle in the Effect channel. */
export interface VolumeManagerApi {
  readonly create: (
    spec: VolumeSpec,
  ) => Effect.Effect<{ readonly volumeId: number; readonly linuxDevice: string }, VolumeFailed>;
  readonly attach: (params: {
    readonly volumeId: number;
    readonly serverId: number;
    readonly automount: boolean;
  }) => Effect.Effect<void, VolumeFailed>;
  readonly detach: (volumeId: number) => Effect.Effect<void, VolumeFailed>;
  readonly setProtection: (
    volumeId: number,
    opts: { readonly delete: boolean },
  ) => Effect.Effect<void, VolumeFailed>;
  readonly delete: (volumeId: number) => Effect.Effect<void, VolumeFailed>;
}

const failed = (e: unknown): VolumeFailed => new VolumeFailed({ reason: String(e) });

/** Build the Effect-facing manager from a raw token (hides HTTP + error mapping). */
export const makeHetznerVolumeManager = (token: string): VolumeManagerApi => ({
  create: (spec) => Effect.tryPromise({ try: () => createVolume(token, spec), catch: failed }),
  attach: (params) => Effect.tryPromise({ try: () => attachVolume(token, params), catch: failed }),
  detach: (volumeId) =>
    Effect.tryPromise({ try: () => detachVolume(token, volumeId), catch: failed }),
  setProtection: (volumeId, opts) =>
    Effect.tryPromise({ try: () => setProtection(token, volumeId, opts), catch: failed }),
  delete: (volumeId) =>
    Effect.tryPromise({ try: () => deleteVolume(token, volumeId), catch: failed }),
});

/** Service tag — kept local (services.ts is owned by another lane). */
export class VolumeManager extends Context.Tag('VolumeManager')<
  VolumeManager,
  VolumeManagerApi
>() {}

/** Live `VolumeManager` — real Hetzner volumes behind the narrow interface. */
export const HetznerVolumeManagerLive: Layer.Layer<VolumeManager, VolumeFailed> = Layer.effect(
  VolumeManager,
  // Reuse the box module's token resolver; re-tag its BoxFailed as VolumeFailed
  // so this seam exposes exactly one error type (no foreign error leaks in).
  hcloudToken.pipe(
    Effect.mapError((e) => new VolumeFailed({ reason: e.reason })),
    Effect.map(makeHetznerVolumeManager),
  ),
);
