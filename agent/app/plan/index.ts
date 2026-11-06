// Placeholder exports so the incident screen compiles before the plan UI lands.
// plan-ui replaces this file; see docs/CONTRACTS.md.
import type {ReactElement} from 'react';

export type PlanLayerContext = {fire: string; t: string};
export function PlanPanel(): ReactElement | null { return null; }
export function BriefingPanel(): ReactElement | null { return null; }
export function HindsightCard(): ReactElement | null { return null; }
export function GuideSteps(): ReactElement | null { return null; }
export function usePlanLayers(_ctx: PlanLayerContext): unknown[] { return []; }
