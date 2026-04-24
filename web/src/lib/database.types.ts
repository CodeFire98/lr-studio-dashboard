// Hand-written types matching supabase/migrations/0001_initial.sql.
// Keep in sync with the schema. Later we can auto-generate via:
//   supabase gen types typescript --project-id <ref> > src/lib/database.types.ts

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type TaskStatus =
  | 'brief'
  | 'progress'
  | 'review'
  | 'delivered'
  | 'revising';

export type AccountType = 'brand' | 'agency';
export type MemberRole = 'owner' | 'member';
export type AssetKind = 'reference' | 'deliverable' | 'wip';

export interface Profile {
  id: string;
  display_name: string;
  initials: string;
  avatar_url: string | null;
  avatar_color: string | null;
  is_agency: boolean;
  created_at: string;
}

export interface Account {
  id: string;
  type: AccountType;
  name: string;
  slug: string | null;
  logo_url: string | null;
  accent_color: string | null;
  created_at: string;
}

export interface AccountMember {
  id: string;
  account_id: string;
  user_id: string;
  role: MemberRole;
  created_at: string;
}

export interface Task {
  id: string;
  account_id: string;
  title: string;
  brief_text: string | null;
  status: TaskStatus;
  deadline: string | null;
  platform: string | null;
  format: string | null;
  objective: string | null;
  creatives_count: number | null;
  assigned_lead_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

export interface Message {
  id: string;
  task_id: string;
  author_id: string;
  body: string;
  created_at: string;
}

export interface Asset {
  id: string;
  task_id: string;
  uploaded_by: string;
  kind: AssetKind;
  version: number;
  storage_path: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  thumbnail_url: string | null;
  created_at: string;
}

export interface Activity {
  id: string;
  task_id: string;
  actor_id: string | null;
  action: string;
  payload: Json;
  created_at: string;
}

export interface BrandKit {
  id: string;
  account_id: string;
  primary_color: string | null;
  secondary_color: string | null;
  logo_url: string | null;
  fonts: Json;
  tone_voice: string | null;
  references: Json;
  updated_at: string;
  tagline: string | null;
  mission: string | null;
  audience: string | null;
  palette: Json;
  voice_tags: Json;
  dos: Json;
  donts: Json;
  ai_summary: string | null;
  photography: Json;
  inspiration: Json;
  past_creatives: Json;
  logos: Json;
}

export interface Invitation {
  id: string;
  account_id: string;
  email: string;
  role: MemberRole;
  invited_by: string | null;
  token: string;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
}
