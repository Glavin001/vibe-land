#!/bin/bash
# The coupled contact's lab A/B on the truck trials: combined section profile
# (uncoupled, as 91d5b2aa2), impact solve uncoupled, impact solve coupled.
cd "$(dirname "$0")/../.."
T=${TRIALS:-framed-house}
scripts/impact/trials.sh impact-hifi-uncoupled "$T" VIBE_SECTION_ROTATION=1 VIBE_IMPACT_CAPACITY=1 PX_DESTRUCTION_IMPACT_COUPLED=0 PX_DESTRUCTION_IMPACT_LOG=1
scripts/impact/trials.sh impact-E-uncoupled "$T" VIBE_IMPACT_CAPACITY=1 PX_DESTRUCTION_IMPACT_COUPLED=0 PX_DESTRUCTION_IMPACT_LOG=1
scripts/impact/trials.sh impact-E-coupled "$T" VIBE_IMPACT_CAPACITY=1 PX_DESTRUCTION_IMPACT_LOG=1
