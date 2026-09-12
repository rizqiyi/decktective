export const PROFILE_THRESHOLDS = {
    /** `heavy`: a handful of commits that still moved a lot of code. */
    heavyMaxCommits: 3,
    heavyGrossChurn: 800,
    heavyConcentration: 120,
    /** `drop`: one dominant commit. */
    dropMinShare: 0.6,
    dropMinGrossChurn: 500,
    /** `rename`: additions and deletions cancel out. */
    renameMinGrossChurn: 200,
    renameMaxAsymmetry: 0.15,
    /** `burst`: many small, evenly sized commits. */
    burstMinCommits: 8,
    burstMaxMedianCommitSize: 60,
    burstMaxShare: 0.35,
    /** `scattered`: broad, shallow touch surface. */
    scatteredMinFilesTouched: 25,
    scatteredMaxConcentration: 40,
};
export function classify(m) {
    const t = PROFILE_THRESHOLDS;
    if (m.commits === 0)
        return "quiet";
    if (m.commits <= t.heavyMaxCommits &&
        (m.grossChurn >= t.heavyGrossChurn || m.concentration >= t.heavyConcentration)) {
        return "heavy";
    }
    if (m.maxCommitShare >= t.dropMinShare && m.grossChurn > t.dropMinGrossChurn) {
        return "drop";
    }
    // Zero churn would make the symmetry ratio 0/0; treat it as fully asymmetric.
    const churn = m.grossChurn > 0 ? m.grossChurn : 1;
    if (m.grossChurn > t.renameMinGrossChurn &&
        Math.abs(m.additions - m.deletions) / churn < t.renameMaxAsymmetry) {
        return "rename";
    }
    if (m.commits >= t.burstMinCommits &&
        m.medianCommitSize <= t.burstMaxMedianCommitSize &&
        m.maxCommitShare < t.burstMaxShare) {
        return "burst";
    }
    if (m.filesTouched >= t.scatteredMinFilesTouched &&
        m.concentration < t.scatteredMaxConcentration) {
        return "scattered";
    }
    return "steady";
}
