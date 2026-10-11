-- "Around town this week" in the weekly summary email. Edit area, radius and interests here.
insert into public.settings (key, value) values
  ('local_events', '{"enabled": true, "area": "Framingham, MA", "radius_miles": 15, "interests": "kid-friendly and family outings (the kids range from kindergarten to teens), plus a few things for adults", "max": 6}')
on conflict (key) do nothing;
