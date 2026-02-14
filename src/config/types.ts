export interface ConfigSnapshot {
  id: number;
  created_at: string;
  trigger: 'startup' | 'reload';
  config_hash: string;
  config_yaml: string;
  source_path: string | null;
}

export interface ConfigSnapshotSummary {
  id: number;
  created_at: string;
  trigger: string;
  config_hash: string;
  source_path: string | null;
}
