import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentRuntimeProcessKey,
  conversationLaneKey,
} from '../server/conversation-session.js';

test('conversation lane keys isolate channel, thread, and DM sessions', () => {
  assert.equal(
    conversationLaneKey({ workspaceId: 'wsp_1', spaceType: 'channel', spaceId: 'chan_all' }),
    'channel:wsp_1:chan_all:top',
  );
  assert.equal(
    conversationLaneKey({ workspaceId: 'wsp_1', spaceType: 'channel', spaceId: 'chan_all', parentMessageId: 'msg_1' }),
    'channel:wsp_1:chan_all:thread:msg_1',
  );
  assert.equal(
    conversationLaneKey({ workspaceId: 'wsp_1', spaceType: 'dm', spaceId: 'dm_alice' }),
    'dm:wsp_1:dm_alice:top',
  );
  assert.equal(
    conversationLaneKey({ workspaceId: 'wsp_1', spaceType: 'dm', spaceId: 'dm_alice', parentMessageId: 'msg_dm' }),
    'dm:wsp_1:dm_alice:thread:msg_dm',
  );
  assert.notEqual(
    agentRuntimeProcessKey('agt_cindy', 'dm:wsp_1:dm_alice:top'),
    agentRuntimeProcessKey('agt_cindy', 'dm:wsp_1:dm_bob:top'),
  );
});
