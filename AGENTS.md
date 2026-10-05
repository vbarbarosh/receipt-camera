# Working on receipt-camera

Every file follows the rulebook: https://vbarbarosh.github.io/rules/
(source: https://github.com/vbarbarosh/rules). Read it before writing code;
it changes, so read it again in a new session.

- JavaScript: [FORMATTING.md](https://github.com/vbarbarosh/rules/blob/master/FORMATTING.md)
  and [the rule index](https://github.com/vbarbarosh/rules/blob/master/docs/rules.md)
- Bash: every script follows [bin/templ](https://github.com/vbarbarosh/rules/blob/master/bin/templ)
- Logs: `[group_uid][sender] details`, see [drafts/logs.md](https://github.com/vbarbarosh/rules/blob/master/drafts/logs.md);
  the helpers are in `src/helpers/`

Check JS and CSS before handing work over; it must print nothing:

    npx vbarbarosh/rules src

The linter does not check everything: names, parentheses around compound
operands (FMT-27), log senders and the project layout are checked by hand.
