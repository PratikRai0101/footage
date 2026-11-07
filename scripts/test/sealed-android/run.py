#!/usr/bin/env python3
"""Cross-language G2 acceptance using cached Kotlin/JDK. No devices or credentials."""
from pathlib import Path
import os
import subprocess
import uuid
ROOT = Path(__file__).resolve().parents[3]
HOME = Path.home()
OUT = ROOT / 'artifacts/sealed-android' / str(uuid.uuid4())
OUT.mkdir(parents=True, mode=0o700)
java = next((HOME / '.gradle/jdks').glob('*21*/*/Contents/Home/bin/java'))
compiler = next((HOME / '.gradle/wrapper/dists').glob('gradle-9.4.1-bin/*/gradle-9.4.1/lib'))
stdlib = compiler / 'kotlin-stdlib-2.3.0.jar'
classes = OUT / 'classes'; classes.mkdir()
native = ROOT / 'apps/mobile/modules/footage-transfer/android/src/main/java/expo/modules/footagetransfer'
sources = [native / name for name in ['PairingWire.kt', 'PairingControl.kt', 'PairingTransport.kt', 'SealedProtocol.kt']]
subprocess.run([str(java), '-cp', str(compiler / '*'), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-classpath', os.pathsep.join(map(str, [stdlib, compiler / 'annotations-24.0.1.jar'])), '-d', str(classes), *map(str, sources), str(ROOT / 'scripts/test/sealed-android/Probe.kt')], check=True)
subprocess.run(['node', '--import', 'tsx', 'scripts/test/sealed-android/vectors.mts', str(OUT), str(java), os.pathsep.join(map(str, [classes, stdlib]))], cwd=ROOT, check=True)
print('Ignored cross-language artifacts:', OUT)
