---
name: debugging
description: >-
  A structured troubleshooting procedure for technical and software problems.
  Use it when the user says something does not work, shows an error, stopped,
  froze or behaves strangely. Keywords: error, bug, does not work, error
  message, crashed, froze, stuck, debug, why not, exception.
metadata:
  author: vellum
  version: "1.0"
---

# Structured troubleshooting

## The principle

Do not guess. Troubleshooting is narrowing down: every step should cut the set
of possible causes in half.

"It does not work" is **not enough information**. First find out exactly what
happens.

## The six steps

### 1. Pin down the symptom

Ask if it is not clear:

- What exactly happens? (not "it fails" but "I do X and get Y")
- What did you expect instead?
- Is there an error message? Word for word?
- When did it start?

**The exact error message is the most valuable piece of information.** Ask for
it verbatim, not paraphrased.

### 2. Reproduce

- Does it happen every time, or only sometimes?
- What is the shortest sequence of steps that triggers it?
- On another machine / with another user / with other data too?

If it cannot be reproduced, that is information in itself: a timing, load or
environment problem is likely.

### 3. Look for a change

**The most common cause: something changed.**

- When did it last work?
- What happened since? (update, config change, new device, power cut)
- If nothing changed "on purpose", what changed by itself? (expired
  certificate, full disk, automatic update)

### 4. Narrow down

Cut the system in two and decide which half holds the fault.

Software:
- Client or server?
- Network or application?
- Configuration or code?

Hardware and industrial systems:
- Mechanical or electrical?
- Sensor, controller or actuator?
- Power, signal or logic?

**Measure, do not assume.** If there is a log, read it. If there is a test
point, measure it.

### 5. Hypothesis and test

State a concrete, falsifiable claim:

> "If the sensor cable is broken, the input always reads 0."

Then test it. If it does not hold, drop it and move on to the next one.

**Change one thing at a time.** Change two and you will not know which helped.

### 6. Verify and close

- Is it really fixed, or did it just disappear?
- Why did it happen? (if you do not know, it will come back)
- Can it be prevented?

## Common traps

**The symptom is not the cause.** If a program dies with out-of-memory, the bug
is not in the memory but in whatever uses it up.

**"We always did it this way" is not evidence.** If it worked yesterday and not
today, the method was not necessarily right - maybe you were lucky so far.

**The latest change is suspicious, but not necessarily guilty.** Sometimes an
old bug only shows up now because the change brought it out.

**Do not fix what you do not understand.** If a random attempt made the error
go away, you did not solve it, you hid it.

## When the user is in a hurry

If it is urgent (production is down, the live system fails):

1. **A workaround first**, so work can continue
2. **Then** the root cause, in calmer conditions

But say clearly that it is a workaround and the real cause is still unknown -
otherwise it gets forgotten and comes back.

## What to ask the user for

- The error message, word for word
- The relevant part of the log
- For a device: the model and the error code
- For code: the failing part and the stack trace

If fresh information about an error code or a specific device is needed, search
for it - and cite the source.
