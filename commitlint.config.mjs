// Enforces: subject leads with "#tckt_<id> " then Conventional Commits.
//   #tckt_a1b2c3 feat(reconciler): add claim loop
const ticketPrefix = /^#tckt_[0-9a-z]+ /;

export default {
  extends: ['@commitlint/config-conventional'],
  parserPreset: {
    parserOpts: {
      headerPattern: /^#(tckt_[0-9a-z]+) (\w+)(?:\(([^)]+)\))?: (.+)$/,
      headerCorrespondence: ['ticket', 'type', 'scope', 'subject'],
    },
  },
  plugins: [
    {
      rules: {
        'ticket-prefix': (parsed) => [
          ticketPrefix.test(parsed.header ?? ''),
          'header must start with "#tckt_<id> " then a conventional type, e.g. "#tckt_a1b2c3 feat(scope): subject"',
        ],
      },
    },
  ],
  rules: {
    'ticket-prefix': [2, 'always'],
    'type-empty': [2, 'never'],
    'subject-empty': [2, 'never'],
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'chore',
        'docs',
        'refactor',
        'test',
        'build',
        'ci',
        'perf',
        'style',
        'revert',
      ],
    ],
  },
};
