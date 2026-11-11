/*
# Lock profile trigger function

1. Security change
- Revoke direct EXECUTE access to `public.create_profile_for_user()` from anonymous and authenticated API roles.
- The function remains available to the database trigger that creates a profile after a new Auth user is created.

2. Important notes
- No tables or user data are changed.
- This prevents callers from invoking the SECURITY DEFINER function through the public API.
*/

revoke execute on function public.create_profile_for_user() from anon, authenticated;
