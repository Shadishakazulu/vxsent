# How to apply this patch

From your repo root:

```bash
cp package.json package.json.bak
cp netlify.toml netlify.toml.bak
cp supabase-schema-final.sql supabase-schema-final.sql.bak

# Copy the files from this patch bundle into the repo root.
npm install
npm run check
netlify dev
```

Then commit:

```bash
git checkout -b harden-vxsent-production
git add .
git commit -m "Harden SENT production config and database schema"
git push origin harden-vxsent-production
```

## Manual cleanup after applying

Archive or delete duplicate pages after confirming no route depends on them:

- `index_updated.html`
- `verify-final.html`
- `verify-production.html`
- `admin-dashboard-final.html`
- `admin-dashboard-production.html`
- `receipt_page.html`

Keep one canonical file per route.
