import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";

const SUPABASE_URL = "https://oweypxjtsetydymatlwu.supabase.co/";
const SUPABASE_ANON_KEY = "sb_publishable_RZwCNQIZBMnthYeVy8CKjQ_rzLzww6G";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);