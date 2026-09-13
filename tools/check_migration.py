#!/usr/bin/env python3
"""Check the hand-written Room migration against the schema Room actually expects.

A Room migration is the one piece of this app that cannot be exercised by a unit test without
the Android SDK, and getting it wrong is not a subtle failure: the app refuses to open the
database and crashes on launch for anybody who already had data.

Room does, however, export exactly what it expects as JSON at build time. So rather than trusting
that the CREATE TABLE statements in Migrations.kt were typed correctly, this compares them - and
the added columns - against that export, and fails the build when they drift apart.

Usage: check_migration.py <schema-dir> <Migrations.kt>
"""
from __future__ import annotations

import json
import pathlib
import re
import sys


def normalise(sql: str) -> str:
    """Collapse whitespace so formatting differences are not reported as schema differences."""
    return re.sub(r"\s+", " ", sql).strip().rstrip(";")


def kotlin_sql_statements(source: str) -> list[str]:
    """Pull every execSQL string literal out of the migration, joining concatenated pieces.

    Scanned rather than regex-matched. SQL is full of parentheses - `FOREIGN KEY(`orderId`)` for
    one - and a regex that stops at the first `)` truncates the statement inside a string literal,
    which then reads as a schema mismatch that is really a parser bug.
    """
    statements = []
    for match in re.finditer(r"execSQL\s*\(", source):
        i = match.end()
        depth = 1
        pieces: list[str] = []
        while i < len(source) and depth > 0:
            c = source[i]
            if c == '"':
                # A string literal. Parentheses inside it are data, not structure.
                i += 1
                piece = []
                while i < len(source):
                    if source[i] == "\\" and i + 1 < len(source):
                        piece.append(source[i + 1])
                        i += 2
                        continue
                    if source[i] == '"':
                        break
                    piece.append(source[i])
                    i += 1
                pieces.append("".join(piece))
            elif c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
            i += 1
        if pieces:
            statements.append(normalise("".join(pieces)))
    return statements


def main() -> int:
    schema_dir = pathlib.Path(sys.argv[1])
    migrations_file = pathlib.Path(sys.argv[2])

    schemas = sorted(schema_dir.glob("*/*.json"))
    if not schemas:
        print("No exported Room schema found; skipping the migration check.")
        return 0

    latest = max(schemas, key=lambda p: int(p.stem))
    schema = json.loads(latest.read_text())
    version = schema["database"]["version"]
    entities = {e["tableName"]: e for e in schema["database"]["entities"]}

    statements = kotlin_sql_statements(migrations_file.read_text())
    print(f"Checking {len(statements)} migration statements against {latest} (version {version})")

    problems: list[str] = []

    # 1. Every table the migration creates must match Room's own CREATE statement exactly.
    created = {}
    for statement in statements:
        match = re.match(r"CREATE TABLE IF NOT EXISTS `?(\w+)`?", statement, re.I)
        if match:
            created[match.group(1)] = statement

    for table, actual in created.items():
        entity = entities.get(table)
        if entity is None:
            problems.append(f"migration creates `{table}`, which is not in the schema at all")
            continue
        expected = normalise(entity["createSql"].replace("${TABLE_NAME}", table))
        if expected != actual:
            problems.append(
                f"`{table}` does not match what Room expects.\n"
                f"    expected: {expected}\n"
                f"    migration: {actual}"
            )

    # 2. Every column the migration adds must exist in the schema, with the same nullability.
    #    A NOT NULL column added here would also need a SQL DEFAULT mirrored by
    #    @ColumnInfo(defaultValue = ...), so this refuses them outright.
    for statement in statements:
        match = re.match(
            r"ALTER TABLE `?(\w+)`? ADD COLUMN `?(\w+)`? (\w+)(.*)", statement, re.I
        )
        if not match:
            continue
        table, column, sql_type, rest = match.groups()
        entity = entities.get(table)
        if entity is None:
            problems.append(f"migration alters `{table}`, which is not in the schema")
            continue
        field = next((f for f in entity["fields"] if f["columnName"] == column), None)
        if field is None:
            problems.append(f"migration adds `{table}`.`{column}`, which no entity declares")
            continue
        if field["affinity"].upper() != sql_type.upper():
            problems.append(
                f"`{table}`.`{column}` is {sql_type} in the migration "
                f"but {field['affinity']} in the schema"
            )
        if field["notNull"]:
            problems.append(
                f"`{table}`.`{column}` is NOT NULL in the schema. A column added by ALTER TABLE "
                f"needs a DEFAULT, which must be mirrored with @ColumnInfo(defaultValue = ...). "
                f"Make it nullable instead."
            )
        if "NOT NULL" in rest.upper():
            problems.append(f"`{table}`.`{column}` adds NOT NULL, which needs a DEFAULT")

    # 3. Every table in the schema must be reachable: either created by this migration or
    #    already present in version 1.
    missing = [t for t in entities if t not in created and t not in V1_TABLES]
    for table in missing:
        problems.append(f"`{table}` is new but no migration creates it")

    if problems:
        print("\nMigration does not match the schema Room expects:\n")
        for problem in problems:
            print(f"  - {problem}")
        return 1

    print(f"Migration matches the schema. {len(created)} tables created, all columns nullable.")
    return 0


# The tables that existed in version 1. Anything outside this set has to be created by a migration.
V1_TABLES = {
    "products",
    "orders",
    "order_items",
    "receipt_images",
    "price_history",
    "pricing_rules",
    "scan_history",
}


if __name__ == "__main__":
    sys.exit(main())
