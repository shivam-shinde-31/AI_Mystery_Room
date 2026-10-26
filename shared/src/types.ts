export type PublicSuspect = { id: string; name: string; age: number; role: string; publicBio: string; alibiClaim: string; portraitSvg: string };
export type EvidenceSummary = { id: string; type: string; title: string; description: string; timestamp: string; relatedSuspectIds: string[]; reliability: 'verified' | 'unverified' };
