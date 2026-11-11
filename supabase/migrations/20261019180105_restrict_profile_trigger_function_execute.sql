/*
# Restrict profile trigger function execution

1. Security change
- Revoke the default PUBLIC EXECUTE grant from the SECURITY DEFINER profile trigger function.
- Keep the function available to the trigger owner without exposing an RPC entry point.

2. Important notes
- No tables or data are changed.
*/

revoke execute on function public.create_profile_for_user() from public;
