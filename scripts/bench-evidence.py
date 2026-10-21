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


PROFILE_PATH = "benchmarks/profile.json"
EVIDENCE_PATHS = (".bench-results/", "benchmarks/results/")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")


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
    directories = [Path(evidence_dir)] if evidence_dir else [root / item for item in EVIDENCE_PATHS]
    for directory in directories:
        path = directory / f"{source}.json"
        if path.is_file():
            yield str(path), path.read_bytes()
    if reference and not evidence_dir:
        path = f"benchmarks/results/{source}.json"
        result = subprocess.run(["git", "-C", str(root), "show", f"{reference}:{path}"], capture_output=True)
        if result.returncode == 0:
            yield f"{reference}:{path}", result.stdout


def check_evidence(root, reference=None, evidence_dir=None):
    files = source_files(root, reference)
    source = fingerprint(files)
    profile_hash, profile = source_profile(files)
    errors = []
    for name, contents in evidence_candidates(root, source, reference, evidence_dir):
        try:
            validate_result(json.loads(contents), source, profile_hash, profile)
            return source, name
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


def confirm_push(failures):
    print("WARNING: Resource benchmark evidence is missing or invalid:", file=sys.stderr)
    for failure in failures:
        print(f"  {failure}", file=sys.stderr)
    print("Run the Docker benchmark when a human completes the PR.", file=sys.stderr)
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
    failures, checked = [], set()
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
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            failures.append(f"{local_ref} ({local_id[:12]}): {error}")
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
