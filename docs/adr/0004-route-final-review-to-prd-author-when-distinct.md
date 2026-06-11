# Route final review to PRD author when distinct

The Code Factory requests final human review from the PRD Author only when the PRD Author differs from the PR Author. Because the factory creates pull requests through the Authenticated GitHub User, the same person may be both requester and PR author; in that case the factory posts the review result and tags the PRD Author instead of requesting self-review.
