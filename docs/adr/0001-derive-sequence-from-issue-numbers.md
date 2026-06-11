# Derive implementation sequence from issue numbers

The Code Factory discovers valid Implementation Issues by checking attached sub-issues for a `## Parent` section whose `Parent PRD: #<num>` reference matches the PRD being processed. It derives the Implementation Sequence by sorting those valid Implementation Issues by GitHub issue number, so the issue publishing workflow must create sub-issues in dependency order and treat issue number order as the durable execution order.
