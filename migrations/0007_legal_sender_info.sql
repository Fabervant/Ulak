-- The operator's sender block that closed the mailed document: the seller must be able to show what
-- the buyer received, and the block carries the seller's identity. Written at each attempt until the
-- mail service accepts the mail, so it holds the block of the mail that went out.
ALTER TABLE legal_documents ADD COLUMN sender_info TEXT;
