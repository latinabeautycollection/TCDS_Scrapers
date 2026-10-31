// Defect/keyword signals mined from title, description and condition text.
// Copied from the legacy HTML parser so the API parser has no cheerio dependency.
export function detectDefects(text) {
  const lower = String(text ?? '').toLowerCase();
  const flag = (re) => (re.test(lower) ? true : null);
  return {
    missing_parts: flag(/missing\s+(?:part|parts|component)/),
    known_damage: flag(/damaged|damage|broken|crack|dent/),
    mechanical_issue: flag(/mechanical issue|engine.*(?:bad|issue|problem)|does not run|not running/),
    electrical_issue: flag(/electrical issue|electrical problem|does not power|no power/),
    cosmetic_damage: flag(/cosmetic|scratch|scuff|dent/),
    not_tested: flag(/not tested|untested|has not been tested/),
    working_condition_unknown: flag(/unknown condition|condition.*unknown|operability.*unknown/),
    key_available: /(?:\b2 keys\b|\b1 key\b|keys? included|comes with.*keys?)/i.test(text) ? true : null,
    screen_damage: flag(/cracked screen|screen.*crack|broken screen/),
    water_damage: flag(/water damage|liquid damage/),
    locked_device: flag(/activation lock|icloud lock|locked device|passcode locked/),
    parts_only: flag(/parts only|for parts/),
    salvage: flag(/salvage/),
  };
}