#!/usr/bin/env python3
"""Run existing 28 native TLS/control negatives after adding the G4 adapter.
The G1-only project intentionally excludes the G4-dependent adapter source; the
whole paired integration runner compiles it with production Background*.swift.
"""
import importlib.util
from pathlib import Path
root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('control_proof', root / 'scripts/pairing-control-probe/run.py')
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)
p.main()
