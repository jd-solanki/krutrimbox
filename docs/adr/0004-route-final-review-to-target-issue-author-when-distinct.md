# Route final review to Target Issue Author when distinct

krutrimbox requests final human review from the Target Issue Author only when the Target Issue Author differs from the PR Author. Because the factory creates pull requests through the Authenticated GitHub User, the same person may be both requester and PR author; in that case the factory posts the review result and tags the Target Issue Author instead of requesting self-review.
