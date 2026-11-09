// What the counter's corner shows, always (brief, sync rule 7).
export type SyncStatus =
  | { state: 'synced'; label: string }
  | { state: 'syncing'; label: string }
  | { state: 'offline'; label: string; pending: number }
  | { state: 'needs_attention'; label: string; reason: string };

export function syncStatus(input: {
  online: boolean;
  uploading: boolean;
  pending: number;              // commands not yet confirmed by the server
  rejected: number;             // commands the server kept with an error
  lastSyncAt: Date | null;
  now: Date;
  /** Offline longer than this needs attention (the licence token and FBR queue depend on it). */
  maxOfflineHours?: number;
}): SyncStatus {
  const maxHours = input.maxOfflineHours ?? 72;
  if (input.rejected > 0) {
    return { state: 'needs_attention', label: 'Needs attention', reason: `${input.rejected} item(s) could not be saved on the server. The owner has been told.` };
  }
  if (!input.online) {
    const hours = input.lastSyncAt ? (input.now.getTime() - input.lastSyncAt.getTime()) / 3_600_000 : Infinity;
    if (hours > maxHours) {
      return { state: 'needs_attention', label: 'Needs attention', reason: `Offline for more than ${maxHours} hours. Connect to the internet soon.` };
    }
    return { state: 'offline', label: input.pending ? `Offline · ${input.pending} waiting` : 'Offline', pending: input.pending };
  }
  if (input.uploading || input.pending > 0) return { state: 'syncing', label: input.pending ? `Syncing ${input.pending}…` : 'Syncing…' };
  return { state: 'synced', label: 'Synced' };
}
