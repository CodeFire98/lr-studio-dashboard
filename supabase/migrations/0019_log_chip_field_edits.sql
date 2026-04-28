-- Log brief-chip edits in the activity feed.
--
-- The activity table's RLS only permits SELECT — writes are expected to come
-- from SECURITY DEFINER triggers. The client previously inserted directly
-- after a chip edit and the row was silently dropped, so users never saw
-- their edits show up in the activity panel.
--
-- This migration extends log_task_activity to also detect changes in the
-- five editable brief chips (count, deadline, format, platform, objective)
-- and emit one 'field_edited' row per changed column, matching the payload
-- shape the existing renderer (mapActivityRow) already understands:
--   { field: <chip-key>, from: <text>, to: <text> }
--
-- The status_changed / assigned blocks are unchanged — kept here verbatim
-- because CREATE OR REPLACE FUNCTION needs the full body.

create or replace function public.log_task_activity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'INSERT') then
    insert into public.activity (task_id, actor_id, action, payload)
    values (new.id, new.created_by, 'created',
            jsonb_build_object('title', new.title, 'status', new.status));
  elsif (tg_op = 'UPDATE') then
    if new.status is distinct from old.status then
      insert into public.activity (task_id, actor_id, action, payload)
      values (new.id, auth.uid(), 'status_changed',
              jsonb_build_object('from', old.status, 'to', new.status));
      if new.status = 'delivered' and old.status <> 'delivered' then
        new.delivered_at = now();
      end if;
    end if;
    if new.assigned_lead_id is distinct from old.assigned_lead_id then
      insert into public.activity (task_id, actor_id, action, payload)
      values (new.id, auth.uid(), 'assigned',
              jsonb_build_object('from', old.assigned_lead_id, 'to', new.assigned_lead_id));
    end if;
    if new.creatives_count is distinct from old.creatives_count then
      insert into public.activity (task_id, actor_id, action, payload)
      values (new.id, auth.uid(), 'field_edited',
              jsonb_build_object('field', 'count',
                                 'from', old.creatives_count::text,
                                 'to',   new.creatives_count::text));
    end if;
    if new.deadline is distinct from old.deadline then
      insert into public.activity (task_id, actor_id, action, payload)
      values (new.id, auth.uid(), 'field_edited',
              jsonb_build_object('field', 'deadline',
                                 'from', to_char(old.deadline, 'Mon FMDD'),
                                 'to',   to_char(new.deadline, 'Mon FMDD')));
    end if;
    if new.format is distinct from old.format then
      insert into public.activity (task_id, actor_id, action, payload)
      values (new.id, auth.uid(), 'field_edited',
              jsonb_build_object('field', 'format',
                                 'from', old.format,
                                 'to',   new.format));
    end if;
    if new.platform is distinct from old.platform then
      insert into public.activity (task_id, actor_id, action, payload)
      values (new.id, auth.uid(), 'field_edited',
              jsonb_build_object('field', 'platform',
                                 'from', old.platform,
                                 'to',   new.platform));
    end if;
    if new.objective is distinct from old.objective then
      insert into public.activity (task_id, actor_id, action, payload)
      values (new.id, auth.uid(), 'field_edited',
              jsonb_build_object('field', 'objective',
                                 'from', old.objective,
                                 'to',   new.objective));
    end if;
  end if;
  return new;
end;
$$;
