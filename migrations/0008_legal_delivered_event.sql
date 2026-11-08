-- The delivered event as the mail service sent it, kept beside the copy for the copy's own keeping
-- period, so the service's own words stand in the record unparsed. Stamped once, from the first
-- delivered event; deleted only with the copy.
ALTER TABLE legal_documents ADD COLUMN delivered_event TEXT;
