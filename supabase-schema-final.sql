-- SENT. Platform - Supabase PostgreSQL Schema
-- Complete database setup for proof storage and verification

-- Create proofs table
CREATE TABLE IF NOT EXISTS proofs (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  proof_id TEXT UNIQUE NOT NULL,
  file_hash TEXT NOT NULL,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  rac_signature TEXT NOT NULL,
  sender_email TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'verified',
  verified_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_proofs_proof_id ON proofs(proof_id);
CREATE INDEX IF NOT EXISTS idx_proofs_sender_email ON proofs(sender_email);
CREATE INDEX IF NOT EXISTS idx_proofs_recipient_email ON proofs(recipient_email);
CREATE INDEX IF NOT EXISTS idx_proofs_created_at ON proofs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_proofs_status ON proofs(status);

-- Enable Row Level Security
ALTER TABLE proofs ENABLE ROW LEVEL SECURITY;

-- Create policy for public read access (anyone can verify)
CREATE POLICY "Public can read proofs" ON proofs
  FOR SELECT USING (true);

-- Create policy for authenticated insert (only from webhook)
CREATE POLICY "Service role can insert proofs" ON proofs
  FOR INSERT WITH CHECK (true);

-- Create policy for authenticated update
CREATE POLICY "Service role can update proofs" ON proofs
  FOR UPDATE USING (true);

-- Create policy for authenticated delete
CREATE POLICY "Service role can delete proofs" ON proofs
  FOR DELETE USING (true);

-- Grant permissions
GRANT SELECT ON proofs TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON proofs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON proofs TO service_role;

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for updated_at
CREATE TRIGGER update_proofs_updated_at BEFORE UPDATE ON proofs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert sample data for testing
INSERT INTO proofs (proof_id, file_hash, timestamp, rac_signature, sender_email, recipient_email, file_name, file_size, status, verified_at)
VALUES (
  'PROOF-1234567890ABCDEF',
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  NOW(),
  '5E884898DA28047151D0E56F8DC62927592A2537D361D91D8F3FE3496DD9A7D1',
  'sender@example.com',
  'recipient@example.com',
  'document.pdf',
  '2.5 MB',
  'verified',
  NOW()
) ON CONFLICT (proof_id) DO NOTHING;
