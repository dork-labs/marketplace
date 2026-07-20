# Linear Ops

Your Linear issues on the dashboard, tended by an agent on a 15-minute inbox check.

Linear Ops is a Shape. A Shape is a saved setup you switch into. When you turn it on, DorkOS rearranges itself for one job: keeping up with your Linear work.

## What you get when you turn it on

- A Linear board on your dashboard. It shows your issues, grouped the way the Linear Loop view groups them.
- A Linear tab in your sidebar, so the board is one click away.
- An offer to set up a "Linear Keeper" agent. This agent checks your Linear inbox and acts on what it can. You choose whether to add it. Nothing is created without your OK.
- A check that looks at your Linear inbox every 15 minutes, once the agent is set up.

## The inbox check waits for the agent

The 15-minute check needs the Linear Keeper agent to run it. If you have not set up that agent yet, DorkOS creates the check but leaves it off. It turns on once the agent exists. That way nothing runs before you say yes.

## You will need a Linear API key

Linear Ops reads your issues through Linear's API. The first time you turn it on, DorkOS asks for your Linear API key (a token from your Linear account). The key is stored on your machine and is never shared. Until you add it, the Linear board shows a "Configure Linear API key" message instead of your issues. That is expected, not a bug.

## Turning it on

Install Linear Ops from the Marketplace in DorkOS. Then press Cmd+K to open the command menu, choose "Switch Shape," pick Linear Ops, and apply it. DorkOS rearranges itself: the Linear board shows up on your dashboard, a Linear tab appears in your sidebar, and DorkOS offers to set up the Linear Keeper agent — your call whether to accept.

You can also ask an agent to do this switch for you, if you'd rather not do it yourself.

## What's inside

Linear Ops does not add new code. It bundles pieces DorkOS already has:

- The built-in Linear issues view (the dashboard board and the sidebar tab).
- A template for the Linear Keeper agent, built on the `/flow` tending and Linear skills.
- The every-15-minutes inbox check.
- A request for your Linear API key.
