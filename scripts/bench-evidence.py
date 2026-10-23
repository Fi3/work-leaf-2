#!/usr/bin/env python3
"""Bind resource benchmark evidence to source contents and check outgoing Git refs."""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

import bench_report


PROFILE_PATH = "benchmarks/profile.json"
EVIDENCE_PATHS = (".bench-results/", "benchmarks/results/")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")


class RegressionFailure(ValueError):
    """Valid measurements exceed the permitted change from the first baseline."""


def git(root, *arguments):
    result = subprocess.run(["git", "-C", str(root), *arguments], capture_output=True)
    if result.returncode:
        raise ValueError(result.stderr.decode(errors="replace").strip())
    return result.stdout


def project_root():
    return Path(git(Path.cwd(), "rev-parse", "--show-toplevel").decode().strip())


def included(path):
    return not any(path.startswith(prefix) for prefix in EVIDENCE_PATHS)


def working_files(root):
    paths = git(root, "ls-files", "--cached", "-z")
    for raw in sorted(set(paths.split(b"\0")) - {b""}):
        path = os.fsdecode(raw)
        if not included(path):
            continue
        source = root / path
        try:
            info = source.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode):
            yield path, "120000", os.fsencode(os.readlink(source))
        elif stat.S_ISREG(info.st_mode):
            mode = "100755" if info.st_mode & stat.S_IXUSR else "100644"
            yield path, mode, source.read_bytes()
        else:
            raise ValueError(f"Unsupported source file: {path}")


def committed_files(root, reference):
    listing = git(root, "ls-tree", "-rz", "--full-tree", f"{reference}^{{tree}}")
    entries = []
    for record in listing.split(b"\0"):
        if not record:
            continue
        metadata, raw_path = record.split(b"\t", 1)
        mode, kind, object_id = metadata.decode().split()
        path = os.fsdecode(raw_path)
        if not included(path):
            continue
        if kind != "blob":
            raise ValueError(f"Unsupported source entry: {path} ({kind})")
        entries.append((path, mode, object_id))
    # One process reads all blobs. This also handles paths with spaces or newlines.
    result = subprocess.run(["git", "-C", str(root), "cat-file", "--batch"],
                            input="".join(item[2] + "\n" for item in entries).encode(),
                            capture_output=True, check=True)
    offset = 0
    for path, mode, _ in entries:
        end = result.stdout.index(b"\n", offset)
        header = result.stdout[offset:end].split()
        size = int(header[2])
        offset = end + 1
        yield path, mode, result.stdout[offset:offset + size]
        offset += size + 1


def source_files(root, reference=None):
    source = committed_files(root, reference) if reference else working_files(root)
    return sorted(source, key=lambda item: os.fsencode(item[0]))


def fingerprint(files):
    digest = hashlib.sha256(b"harness-source-v1\0")
    for path, mode, content in files:
        digest.update(mode.encode() + b" " + os.fsencode(path) + b"\0")
        digest.update(hashlib.sha256(content).digest())
    return digest.hexdigest()


def source_profile(files):
    for path, _, content in files:
        if path == PROFILE_PATH:
            profile = json.loads(content)
            if not isinstance(profile, dict):
                raise ValueError("The benchmark profile must be an object")
            return hashlib.sha256(content).hexdigest(), profile
    raise ValueError(f"Missing benchmark profile: {PROFILE_PATH}")


def validate_result(result, source, profile_hash, profile):
    if not isinstance(result, dict) or type(result.get("schema")) is not int or result["schema"] != 1:
        raise ValueError("Unsupported benchmark evidence schema")
    if result.get("source_fingerprint") != source:
        raise ValueError("Benchmark source does not match the outgoing source")
    if result.get("profile_sha256") != profile_hash:
        raise ValueError("Benchmark profile does not match the outgoing profile")
    image = result.get("docker_image_id", "")
    if not isinstance(image, str) or not image.startswith("sha256:") or not SHA256.fullmatch(image[7:]):
        raise ValueError("Benchmark evidence has no Docker image digest")
    if result.get("completed") is not True:
        raise ValueError("Benchmark run is incomplete")
    exhaustion = result.get("exhaustion")
    if not isinstance(exhaustion, dict) or exhaustion.get("observed") is not True:
        raise ValueError("Benchmark run did not observe resource exhaustion")
    if exhaustion.get("reason") != "memory_limit" or exhaustion.get("phase") != "capacity":
        raise ValueError("Benchmark must reach memory exhaustion during the capacity phase")
    if not isinstance(result.get("measurements"), list) or not result["measurements"]:
        raise ValueError("Benchmark evidence has no measurements")
    previous_cpu = 0
    for sample in result["measurements"]:
        if not isinstance(sample, dict):
            raise ValueError("Benchmark measurement must be an object")
        for field in ("cpu_usec", "memory_bytes"):
            value = sample.get(field)
            if (not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0
                    or (isinstance(value, float) and not math.isfinite(value))):
                raise ValueError(f"Invalid benchmark measurement: {field}")
        if sample["cpu_usec"] < previous_cpu:
            raise ValueError("Cumulative CPU measurements are not monotonic")
        previous_cpu = sample["cpu_usec"]
    if result.get("profile") != profile:
        raise ValueError("Recorded benchmark limits do not match the profile")
    if result.get("docker_limits") != profile.get("resources") or not isinstance(profile.get("resources"), dict):
        raise ValueError("Actual Docker limits do not match the profile")
    for field in ("oom_delta", "oom_kill_delta"):
        count = exhaustion.get(field)
        if not isinstance(count, int) or isinstance(count, bool) or count <= 0:
            raise ValueError(f"Memory exhaustion has no positive observed cgroup {field}")


def evidence_candidates(root, source, reference=None, evidence_dir=None):
    if reference and not evidence_dir:
        path = f"benchmarks/results/{source}.json"
        result = subprocess.run(["git", "-C", str(root), "show", f"{reference}:{path}"], capture_output=True)
        if result.returncode == 0:
            yield f"{reference}:{path}", result.stdout
            # The outgoing commit owns its result, including failures or invalid data.
            return
    directories = [Path(evidence_dir)] if evidence_dir else [root / item for item in EVIDENCE_PATHS]
    for directory in directories:
        path = directory / f"{source}.json"
        if path.is_file():
            yield str(path), path.read_bytes()


def check_evidence(root, reference=None, evidence_dir=None):
    files = source_files(root, reference)
    source = fingerprint(files)
    profile_hash, profile = source_profile(files)
    errors = []
    for name, contents in evidence_candidates(root, source, reference, evidence_dir):
        try:
            result = json.loads(contents)
            validate_result(result, source, profile_hash, profile)
            evaluation = bench_report.evaluate(result, bench_report.load_baseline(root))
            if evaluation["status"] == "FAIL":
                raise RegressionFailure(f"{name}: benchmark regression limit exceeded.\n"
                                        + bench_report.render_failures(evaluation))
            if evaluation["status"] != "PASS":
                raise ValueError("Benchmark comparison is unavailable: " + "; ".join(evaluation["reasons"]))
            return source, name
        except RegressionFailure:
            raise
        except (ValueError, TypeError) as error:
            errors.append(f"{name}: {error}")
    raise ValueError("; ".join(errors) if errors else f"No benchmark evidence for source {source}")


def snapshot(root, destination):
    destination = Path(destination).resolve()
    if destination == root or root in destination.parents:
        raise ValueError("The source snapshot must be outside the repository")
    if destination.exists() and any(destination.iterdir()):
        raise ValueError("The source snapshot directory must be empty")
    files = source_files(root)
    destination.mkdir(parents=True, exist_ok=True)
    for name, mode, content in files:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if mode == "120000":
            target.symlink_to(os.fsdecode(content))
        else:
            target.write_bytes(content)
            target.chmod(0o755 if mode == "100755" else 0o644)
    return fingerprint(files)


def print_failures(title, failures):
    print(title, file=sys.stderr)
    for failure in failures:
        print(f"  {failure}", file=sys.stderr)


def confirm_push(failures):
    print_failures("WARNING: Resource benchmark evidence is missing or invalid:", failures)
    print("""
To record matching evidence before you retry the push:
  1. Save local changes, then switch to each outgoing branch listed above:
       git switch OUTGOING_BRANCH
       git rev-parse HEAD
     Verify that HEAD is the listed outgoing commit. Evidence for another
     branch or source tree does not satisfy this check.
  2. Complete the correctness checks:
       sh scripts/check.sh
  3. Commit all source, documentation, and check evidence changes, including
     new files, so the measurement starts from committed source:
       git add PATH...
       git commit
     Complete all source and documentation changes before measurement.
     --publish requires a checked-out branch with no uncommitted source.
  4. When a human completes the PR or requests a measurement, run:
       python3 scripts/bench.py --publish
     To use two available high-numbered CPUs, for example CPUs 30 and 31:
       python3 scripts/bench.py --publish --cpuset-cpus 30,31
     Docker on Linux x86_64 with cgroup v2 is required. Measurement uses two
     CPU cores, 512 MiB RAM, no swap, and no network. It continues to verified
     memory exhaustion, with a ten-minute timeout. Image preparation can take
     additional time and use the network. No paid model access is required.
  5. On PASS, --publish automatically commits only the generated benchmark
     result and validates that commit. No manual evidence commit is needed.
     A failed measurement does not create a commit.
     Retry the push. Repeat measurement if source or documentation changes;
     an evidence-only commit does not change the source fingerprint.

The benchmark is separate from the normal release gate. This hook does not run
it automatically. Read PERFORMANCE.md for the workload and evidence rules.
""", file=sys.stderr)
    try:
        with open("/dev/tty", encoding="utf-8") as reader, open("/dev/tty", "w", encoding="utf-8", buffering=1) as writer:
            writer.write("Push these unmeasured changes? Type yes to continue: ")
            writer.flush()
            answer = reader.readline().strip()
    except OSError:
        print("Push stopped: no terminal is available for explicit confirmation.", file=sys.stderr)
        return 1
    if answer != "yes":
        print("Push stopped: benchmark evidence was not accepted.", file=sys.stderr)
        return 1
    print("WARNING: Proceeding without valid resource benchmark evidence.", file=sys.stderr)
    return 0


def pre_push(root, lines):
    failures, regressions, checked = [], [], set()
    for line in lines:
        fields = line.split()
        if len(fields) != 4:
            raise ValueError("Invalid Git pre-push input")
        local_ref, local_id, _, _ = fields
        if set(local_id) == {"0"} or local_id in checked:
            continue
        checked.add(local_id)
        try:
            _, evidence = check_evidence(root, local_id)
            print(f"Benchmark evidence: {local_ref}: {evidence}", file=sys.stderr)
        except RegressionFailure as error:
            regressions.append(f"{local_ref} ({local_id[:12]}): {error}")
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            failures.append(f"{local_ref} ({local_id[:12]}): {error}")
    if regressions:
        print_failures("Push stopped: measured benchmark regressions exceed the permitted limits.", regressions)
        if failures:
            print_failures("Other outgoing sources have missing or invalid evidence:", failures)
        print("Correct and commit the regression fix, then repeat the authorized measurement.\n"
              "Run: python3 scripts/bench.py --publish\n"
              "A passing --publish run automatically commits its evidence.\n"
              "A measured failure has no confirmation override. Read PERFORMANCE.md for the limits.", file=sys.stderr)
        return 1
    return confirm_push(failures) if failures else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("fingerprint", "validate"):
        command = commands.add_parser(name)
        command.add_argument("--ref")
        if name == "validate":
            command.add_argument("--evidence-dir")
    commands.add_parser("snapshot").add_argument("destination")
    push = commands.add_parser("pre-push")
    push.add_argument("remote", nargs="?")
    push.add_argument("url", nargs="?")
    args = parser.parse_args()
    try:
        root = project_root()
        if args.command == "fingerprint":
            print(fingerprint(source_files(root, args.ref)))
        elif args.command == "validate":
            source, evidence = check_evidence(root, args.ref, args.evidence_dir)
            print(json.dumps({"source_fingerprint": source, "evidence": evidence}))
        elif args.command == "snapshot":
            print(snapshot(root, args.destination))
        else:
            return pre_push(root, sys.stdin)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"Benchmark evidence: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
