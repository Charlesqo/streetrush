#!/usr/bin/env bash
set -euo pipefail

ROOT="/Volumes/Storage/streetrush/research-output/audio-20260907/shared"
ORIG="$ROOT/originals"
SEL="$ROOT/previews/selected"
mkdir -p "$SEL"

extract() {
  local archive="$1"
  local entry="$2"
  local out="$3"
  bsdtar -xOf "$ORIG/$archive" "$entry" > "$SEL/$out"
}

# Archive extraction only: no resampling, clipping, normalization, or fades.
extract "kenney_interface-sounds.zip" "Audio/click_001.ogg" "kenney_ui_click_001.ogg"
extract "kenney_interface-sounds.zip" "Audio/confirmation_001.ogg" "kenney_ui_confirmation_001.ogg"
extract "kenney_interface-sounds.zip" "Audio/error_001.ogg" "kenney_ui_error_001.ogg"
extract "kenney_interface-sounds.zip" "Audio/open_001.ogg" "kenney_ui_open_001.ogg"

extract "kenney_impact-sounds.zip" "Audio/impactMetal_heavy_000.ogg" "kenney_impact_metal_heavy_000.ogg"
extract "kenney_impact-sounds.zip" "Audio/impactGlass_heavy_000.ogg" "kenney_impact_glass_heavy_000.ogg"

extract "car_sound_effects_pack.zip" "Car_Acceleration.ogg" "carpack_acceleration.ogg"
extract "car_sound_effects_pack.zip" "Car_Acceleration_2.ogg" "carpack_acceleration_2.ogg"
extract "car_sound_effects_pack.zip" "Car_Engine_Loop.ogg" "carpack_engine_loop.ogg"
extract "car_sound_effects_pack.zip" "Car_Parking_Brake.ogg" "carpack_parking_brake.ogg"

extract "carskid.7z" "carskid/skid-loop.wav" "carskid_skid_loop.wav"
extract "carskid.7z" "carskid/skid-piece-fadeinout.wav" "carskid_skid_piece_fadeinout.wav"
extract "carskid.7z" "carskid/skid-piece.wav" "carskid_skid_piece.wav"

extract "wind.zip" "wind/Wind.ogg" "wind_01.ogg"
extract "wind.zip" "wind/Wind2.ogg" "wind_02.ogg"
extract "different_steps.zip" "gravel.ogg" "surface_gravel.ogg"
extract "100-CC0-wood-metal-SFX.zip" "metal_slam_01.ogg" "metal_pack_slam.ogg"

printf '%s\n' 'Archive extraction complete; source files remain under originals/.' > "$ROOT/evidence/extraction_note.txt"
