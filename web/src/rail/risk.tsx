import type {FireData} from '../data/fire';
import {Card, Pending} from './ui';

/** Risk tab rail: post-fire debris-flow likelihood. Filled by the Risk build. */
export function RiskRail(_: {fire: FireData}) {
  return (
    <Card title="Post-fire debris flows">
      <Pending>Debris-flow models are not computed yet.</Pending>
    </Card>
  );
}
