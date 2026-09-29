import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  adapterFor,
  createSpecBatch,
  java,
  javaFacts,
} from '../../src/core/index.js'

const roots: string[] = []

async function writeFixture(
  root: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const file = join(root, ...relativePath.split('/'))

  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content, 'utf8')
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(root =>
      rm(root, { recursive: true, force: true }),
    ),
  )
})

describe('Java language adapter', () => {
  it('extracts Java structural facts from source text only', () => {
    const lines = [
      'package com.example.service;',
      '',
      'import com.example.model.User;',
      'import java.util.List;',
      'import static java.util.Collections.emptyList;',
      '',
      'public final class UserService {',
      '  public static class Builder {}',
      '  private final String example = "public class Fake {}";',
      '}',
      '',
      '// public class CommentedOut {}',
      '/* public interface AlsoNotReal {} */',
    ]

    const facts = javaFacts(lines.join('\n'))

    expect(facts.exports).toEqual(['UserService'])

    expect(facts.imports).toEqual([
      'com.example.model.User',
      'java.util.Collections.emptyList',
      'java.util.List',
    ])

    expect(facts.lineCount).toBe(lines.length)
  })

  it('recognises public top-level Java classes, interfaces, enums, and records', () => {
    expect(
      javaFacts('public class UserService {}').exports,
    ).toEqual(['UserService'])

    expect(
      javaFacts('public interface UserRepository {}').exports,
    ).toEqual(['UserRepository'])

    expect(
      javaFacts('public enum UserStatus { ACTIVE, INACTIVE }').exports,
    ).toEqual(['UserStatus'])

    expect(
      javaFacts('public record UserView(String id, String name) {}').exports,
    ).toEqual(['UserView'])

    expect(
      javaFacts('public sealed interface Payment permits CardPayment {}').exports,
    ).toEqual(['Payment'])
  })

  it('recognises annotations between public modifiers and the type keyword', () => {
    expect(
      javaFacts('public @Deprecated class Foo {}').exports,
    ).toEqual(['Foo'])

    expect(
      javaFacts('public final @Deprecated class Bar {}').exports,
    ).toEqual(['Bar'])

    expect(
      javaFacts('public @Deprecated final class Baz {}').exports,
    ).toEqual(['Baz'])

    expect(
      javaFacts('public @SuppressWarnings("unused") final class Qux {}').exports,
    ).toEqual(['Qux'])
  })

  it('claims Java files and excludes declaration-style Java files', () => {
    expect([...java.extensions]).toEqual(['.java'])

    expect(adapterFor('UserService.java')?.id).toBe('java')

    // adapterFor normalises the extension before matching.
    expect(adapterFor('UserService.JAVA')?.id).toBe('java')

    expect(java.exclude?.('package-info.java')).toBe('declaration-file')
    expect(java.exclude?.('module-info.java')).toBe('declaration-file')
    expect(java.exclude?.('UserService.java')).toBeUndefined()
  })

  it('discovers Java files and excludes declarations and generated/build folders', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ditto-java-'))
    roots.push(root)

    const source = join(root, 'source')
    const output = join(root, 'specifications')

    await writeFixture(
      source,
      'src/main/java/com/example/UserService.java',
      `package com.example;

import java.util.List;

public class UserService {
}
`,
    )

    await writeFixture(
      source,
      'src/main/java/com/example/UserRepository.java',
      `package com.example;

public interface UserRepository {
}
`,
    )

    await writeFixture(
      source,
      'src/main/java/com/example/User.java',
      `package com.example;

public record User(String id) {
}
`,
    )

    await writeFixture(
      source,
      'src/main/java/com/example/UserStatus.java',
      `package com.example;

public enum UserStatus {
    ACTIVE,
    INACTIVE
}
`,
    )

    await writeFixture(
      source,
      'src/main/java/com/example/package-info.java',
      `@Deprecated
package com.example;
`,
    )

    await writeFixture(
      source,
      'src/main/java/module-info.java',
      `module com.example {
}
`,
    )

    await writeFixture(
      source,
      'target/generated-sources/GeneratedUser.java',
      `public class GeneratedUser {
}
`,
    )

    await writeFixture(
      source,
      'generated/GeneratedMapper.java',
      `public class GeneratedMapper {
}
`,
    )

    await writeFixture(
      source,
      'README.md',
      '# Example',
    )

    const batch = await createSpecBatch({
      sourceRoot: source,
      outputRoot: output,
    })

    expect(batch.items).toHaveLength(4)

    expect(
      batch.items.every(item => item.language === 'java'),
    ).toBe(true)

    expect(batch.discovery.inScope).toBe(4)

    expect(
      batch.discovery.excludedByReason['declaration-file'],
    ).toBe(2)

    expect(
      batch.discovery.excludedByReason['ignored-folder'],
    ).toBe(2)

    expect(
      batch.discovery.excludedByReason['non-code'],
    ).toBe(1)

    expect(batch.discovery.excluded).toEqual(
      expect.arrayContaining([
        {
          relativePath: 'src/main/java/com/example/package-info.java',
          reason: 'declaration-file',
        },
        {
          relativePath: 'src/main/java/module-info.java',
          reason: 'declaration-file',
        },
        {
          relativePath: 'target',
          reason: 'ignored-folder',
        },
        {
          relativePath: 'generated',
          reason: 'ignored-folder',
        },
      ]),
    )
  })
})