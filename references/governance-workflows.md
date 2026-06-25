# Governance Workflows

Use these workflows for ordinary community governance actions:

- create a signal proposal;
- vote yes or no on an active proposal;
- query governance config and proposal state.

Do not treat this reference as an operator runbook. Community governance should stay simple and reusable.

## Community Scope

Community governance helpers should cover:

- proposal readiness;
- proposer balance and threshold checks;
- proposal submission;
- vote readiness;
- vote coin selection;
- post-submit proposal readback.

They should not try to manage outcomes, keep proposals open intentionally, auto-finalize, or auto-execute.

## Proposal Flow

1. Resolve the signer environment.
2. Read governance config.
3. Check:
   - proposal creation is not paused;
   - no other active proposal exists;
   - signer has enough PPRF for proposer stake;
   - signer has enough SUI for gas.
4. Build a signal proposal with:
   - `title`
   - `description`
   - `actionType`
   - optional `payloadText`
   - optional `payloadAddress`
5. Submit the transaction only when the user explicitly asked to write.
6. Read back the created proposal object and report:
   - proposal id
   - proposal object id
   - transaction digest
   - current status
   - end epoch

### Create Proposal Helper

Dry-run/preflight:

```powershell
node .\scripts\create-signal-proposal.mjs --preflight --title="..." --description="..." --stake-pprf=10000000 --signer-env=.\signer.env --account=1
```

Real write:

```powershell
node .\scripts\create-signal-proposal.mjs --run --title="..." --description="..." --stake-pprf=10000000 --signer-env=.\signer.env --account=1
```

## Vote Flow

1. Resolve the signer environment.
2. Resolve the proposal by numeric id or proposal object id.
3. Read governance config and proposal state.
4. Check:
   - proposal is active;
   - signer has not already voted;
   - signer has a PPRF coin strictly greater than the minimum vote stake;
   - signer has enough SUI for gas.
5. Build either `voteYes` or `voteNo`.
6. Submit only when the user explicitly asked to write.
7. Read back the proposal and report:
   - transaction digest
   - updated yes votes
   - updated no votes
   - current status
   - whether outcome is already determinable

### Important Vote Rule

Current governance requires:

- vote stake must be strictly greater than `MIN_VOTE_STAKE`
- not greater-than-or-equal

So if the minimum is `100 PPRF`, then `100 PPRF` fails and `101 PPRF` succeeds.

### Vote Helper

Dry-run/preflight:

```powershell
node .\scripts\vote-proposal.mjs --preflight --proposal=22 --side=yes --stake-pprf=101 --signer-env=.\signer.env --account=2
```

Real write:

```powershell
node .\scripts\vote-proposal.mjs --run --proposal=22 --side=no --stake-pprf=101 --signer-env=.\signer.env --account=3
```

## Query Flow

Use `query-governance.mjs` when the user asks:

- what is the current proposer threshold;
- whether governance is paused;
- which proposal is active;
- what a specific proposal’s status or vote counts are.

Examples:

```powershell
node .\scripts\query-governance.mjs
node .\scripts\query-governance.mjs --proposal=22
node .\scripts\query-governance.mjs --proposal=0x...
```

## User-Facing Report Shape

For proposal creation:

```text
Proposal created: <title>
Proposal ID: <id>
Proposal object: <object id>
Transaction: <digest>
Status: <active/passed/rejected/...>
```

For voting:

```text
Vote submitted: yes|no
Proposal ID: <id>
Proposal object: <object id>
Transaction: <digest>
Yes votes: <raw or formatted>
No votes: <raw or formatted>
Status: <active/passed/rejected/...>
```

For read-only governance inspection:

```text
Governance config: <object id>
Active proposal: <id or none>
Proposer threshold: <raw or formatted>
Proposal duration epochs: <n>
Proposal creation paused: true|false
```
