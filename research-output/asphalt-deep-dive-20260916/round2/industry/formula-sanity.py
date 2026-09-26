"""Algebraic checks only: no GPU execution, no source material or shader changes."""
import json
from pathlib import Path


def sat(x):
    return max(0.0, min(1.0, x))


def gt7_slide95(ao, ndotl, alpha):
    return sat(ndotl - alpha * (1.0 - ao) + 0.5)


def uncharted4_slide37(ao, ndotl):
    return sat(abs(ndotl) + 2.0 * ao * ao - 1.0)


rows = []
for ao in (1.0, 0.8, 0.5):
    for ndotl in (0.1, 0.25, 0.5, 1.0):
        rows.append(dict(
            ao=ao, ndotl=ndotl,
            gt7_alpha_0=gt7_slide95(ao, ndotl, 0.0),
            gt7_alpha_1=gt7_slide95(ao, ndotl, 1.0),
            gt7_alpha_2=gt7_slide95(ao, ndotl, 2.0),
            uncharted4=uncharted4_slide37(ao, ndotl),
        ))

result = {
    'scope': 'Scalar formula evaluation, not game rendering or physical validation.',
    'interpretation_assumption': 'Treat formulas as extra direct-light visibility multipliers.',
    'findings': {
        'gt7_alpha_zero_is_not_identity': gt7_slide95(1.0, 0.1, 0.0) != 1.0,
        'gt7_white_ao_grazing_value': gt7_slide95(1.0, 0.1, 1.0),
        'uncharted_white_ao_is_identity_on_sample_grid': all(
            uncharted4_slide37(1.0, q / 100.0) == 1.0 for q in range(-100, 101)),
    },
    'rows': rows,
}
out = Path(__file__).with_suffix('.json')
out.write_text(json.dumps(result, indent=2), encoding='utf-8')
print(json.dumps(result['findings'], indent=2))
