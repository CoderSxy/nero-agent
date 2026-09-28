import { MASTRA_ORIGIN } from '../constants';

export function StudioPage() {
  return <iframe className="studio-frame" title="Mastra Studio" src={MASTRA_ORIGIN} />;
}
