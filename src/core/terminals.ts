/**
 * Main passenger terminals of cities served by several stations.
 *
 * A fixed, hand-written list (not derived from distance or train counts, which
 * would pull in small halts): journeys from "Delhi" can start at any of these.
 * Codes are the official timetable's; callers drop codes their timetable lacks.
 */
export const CITY_TERMINALS: ReadonlyArray<{ city: string; codes: readonly string[] }> = [
  { city: "Delhi", codes: ["NDLS", "DLI", "NZM", "ANVT", "DEE"] },
  { city: "Mumbai", codes: ["CSMT", "LTT", "MMCT", "BDTS", "DR"] },
  { city: "Kolkata", codes: ["HWH", "SDAH", "KOAA", "SRC", "SHM"] },
  { city: "Chennai", codes: ["MAS", "MS"] },
  { city: "Bengaluru", codes: ["SBC", "YPR", "SMVB", "BNC"] },
  { city: "Hyderabad", codes: ["SC", "HYB", "KCG", "LPI"] },
  { city: "Patna", codes: ["PNBE", "RJPB", "PPTA", "DNR"] },
  { city: "Lucknow", codes: ["LKO", "LJN"] },
  { city: "Varanasi", codes: ["BSB", "BSBS", "BCY"] },
  { city: "Prayagraj", codes: ["PRYJ", "PRG", "PCOI"] },
  { city: "Kanpur", codes: ["CNB", "CPA"] },
  { city: "Agra", codes: ["AGC", "AF", "IDH"] },
  { city: "Guwahati", codes: ["GHY", "KYQ"] },
  { city: "Kochi", codes: ["ERS", "ERN"] },
  { city: "Bhopal", codes: ["BPL", "RKMP"] },
  { city: "Pune", codes: ["PUNE", "HDP"] },
  { city: "Nagpur", codes: ["NGP", "AJNI"] },
  { city: "Indore", codes: ["INDB", "LMNR"] },
];

/**
 * The station itself first, then the other main terminals of its city (only those `known` accepts).
 * A station outside the list is returned alone.
 */
export function cityTerminals(code: string, known: (code: string) => boolean = () => true): string[] {
  const group = CITY_TERMINALS.find((g) => g.codes.includes(code));
  if (!group) return [code];
  return [code, ...group.codes.filter((c) => c !== code && known(c))];
}
