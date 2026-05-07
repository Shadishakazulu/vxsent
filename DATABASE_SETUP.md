# SENT. Database Setup Guide

## Overview
This guide explains how to set up a Supabase database to persist proof records for the SENT. platform.

## Why Supabase?
- **Free tier**: Sufficient for MVP with generous limits
- **Real-time capabilities**: Can add real-time updates later
- **PostgreSQL-based**: Reliable, scalable, industry-standard
- **Easy integration**: Simple REST API and JavaScript client
- **Row-Level Security**: Built-in security policies

## Setup Steps

### 1. Create a Supabase Project
1. Go to [supabase.com](https://supabase.com)
2. Sign up or log in
3. Click "New Project"
4. Fill in:
   - **Name**: `sent-platform` (or your preference)
   - **Database Password**: Create a strong password (save this!)
   - **Region**: Choose closest to your users
5. Click "Create new project" and wait for setup (~2 minutes)

### 2. Create the Proofs Table
Once your project is ready:

1. Go to the **SQL Editor** in the left sidebar
2. Click "New Query"
3. Paste the following SQL:

```sql
-- Create proofs table
CREATE TABLE proofs (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  proof_id TEXT UNIQUE NOT NULL,
  file_hash TEXT NOT NULL,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  rac_signature TEXT NOT NULL,
  sender_email TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size TEXT NOT NULL,
  status TEXT DEFAULT 'verified',
  verified_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for faster lookups
CREATE INDEX idx_proof_id ON proofs(proof_id);
CREATE INDEX idx_sender_email ON proofs(sender_email);
CREATE INDEX idx_recipient_email ON proofs(recipient_email);
CREATE INDEX idx_created_at ON proofs(created_at DESC);

-- Enable Row Level Security
ALTER TABLE proofs ENABLE ROW LEVEL SECURITY;

-- Create policy to allow anyone to read proofs (public verification)
CREATE POLICY "Allow public read access" ON proofs
  FOR SELECT USING (true);

-- Create policy to allow insert from authenticated users or webhook
CREATE POLICY "Allow insert from authenticated" ON proofs
  FOR INSERT WITH CHECK (true);
```

4. Click "Run" to execute the SQL

### 3. Get Your API Credentials
1. Go to **Settings** → **API**
2. Copy and save:
   - **Project URL**: `https://[project-id].supabase.co`
   - **Anon Key**: The public key (safe to expose in frontend)
   - **Service Role Key**: The secret key (keep private, use in backend only)

### 4. Update Your Environment Variables

In your Netlify Functions or backend:

```env
SUPABASE_URL=https://[project-id].supabase.co
SUPABASE_ANON_KEY=[your-anon-key]
SUPABASE_SERVICE_KEY=[your-service-key]
```

### 5. Update the Webhook to Store Proofs

Modify `netlify/functions/stripe-webhook.js` to insert proofs into Supabase:

```javascript
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Inside your webhook handler, after generating the proof:
const { error } = await supabase
  .from('proofs')
  .insert([
    {
      proof_id: proofId,
      file_hash: fileHash,
      timestamp: new Date().toISOString(),
      rac_signature: racSignature,
      sender_email: senderEmail,
      recipient_email: recipientEmail,
      file_name: fileName,
      file_size: fileSize,
      status: 'verified',
      verified_at: new Date().toISOString()
    }
  ]);

if (error) {
  console.error('Error storing proof:', error);
}
```

### 6. Update the Verification Page

Modify `verify.html` to query Supabase instead of using mock data:

```javascript
const SUPABASE_URL = 'https://[project-id].supabase.co';
const SUPABASE_ANON_KEY = '[your-anon-key]';

async function verifyProof() {
  const proofId = document.getElementById('proofId').value.trim();
  
  if (!proofId) {
    showResult('error', 'Please enter a Proof ID');
    return;
  }

  // Show loading state
  const resultDiv = document.getElementById('result');
  resultDiv.className = 'result loading';
  resultDiv.innerHTML = '<div class="result-title">Verifying Proof...</div><div class="spinner"></div>';

  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/proofs?proof_id=eq.${proofId}`,
      {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    const data = await response.json();

    if (data.length > 0) {
      const proof = data[0];
      showResult('success', 'Proof Verified Successfully', proof);
    } else {
      showResult('error', 'Proof not found. Please check the Proof ID and try again.');
    }
  } catch (error) {
    console.error('Error verifying proof:', error);
    showResult('error', 'An error occurred while verifying the proof. Please try again.');
  }
}
```

## Testing

1. **Create a test proof** by going through the payment flow
2. **Verify the proof** by:
   - Going to your Supabase dashboard
   - Checking the `proofs` table to see the inserted record
   - Using the verify.html page with the Proof ID

## Security Considerations

- **Row Level Security (RLS)**: Enabled to prevent unauthorized access
- **Public Read**: Anyone can verify a proof (intentional for transparency)
- **Service Key**: Only used server-side for inserts/updates
- **Anon Key**: Safe to expose in frontend for read-only queries

## Scaling

For production, consider:
- **Backups**: Supabase handles daily backups automatically
- **Monitoring**: Set up alerts for unusual activity
- **Rate Limiting**: Implement on your API endpoints
- **Caching**: Use Redis for frequently accessed proofs

## Support

For issues with Supabase:
- [Supabase Documentation](https://supabase.com/docs)
- [Supabase Community](https://github.com/supabase/supabase/discussions)
