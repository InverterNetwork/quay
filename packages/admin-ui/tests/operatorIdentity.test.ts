import { expect, test } from 'bun:test';
import { resolveOperatorIdentity } from '../src/operatorIdentity';

test('resolves operator identity from Quay meta viewer display name', () => {
  expect(
    resolveOperatorIdentity({
      label: 'Fabian Scherer',
      display_name: 'Fabian Scherer',
      slack_user_id: 'U06TDC56VJB',
    }),
  ).toEqual({
    label: 'Fabian Scherer',
    avatarName: 'Fabian Scherer',
    displayName: 'Fabian Scherer',
    slackUserId: 'U06TDC56VJB',
  });
});

test('falls back to You when Quay meta has no display name', () => {
  expect(resolveOperatorIdentity(null)).toEqual({
    label: 'You',
    avatarName: 'You',
    displayName: null,
    slackUserId: null,
  });
  expect(
    resolveOperatorIdentity({
      label: '  ',
      display_name: null,
      slack_user_id: '  ',
    }),
  ).toEqual({
    label: 'You',
    avatarName: 'You',
    displayName: null,
    slackUserId: null,
  });
});
