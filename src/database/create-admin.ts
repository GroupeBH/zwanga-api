import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import dataSource from './data-source';
import { User, UserRole } from '../users/entities/user.entity';
import { provisionAdminAccount } from '../admin/admin-account.provisioning';
import { type AdminUserRole } from '../users/user-role.policy';

interface CliOptions {
  phone?: string;
  firstName?: string;
  lastName?: string;
  role?: AdminUserRole;
}

function readCliOptions(): CliOptions {
  const { values } = parseArgs({
    options: {
      phone: { type: 'string' },
      'first-name': { type: 'string' },
      'last-name': { type: 'string' },
      role: { type: 'string' },
    },
    allowPositionals: false,
    strict: true,
  });

  return {
    phone: values.phone,
    firstName: values['first-name'],
    lastName: values['last-name'],
    role: values.role as AdminUserRole | undefined,
  };
}

async function readVisibleInputs(
  options: CliOptions,
): Promise<Required<CliOptions>> {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const phone = options.phone ?? (await terminal.question('Téléphone : '));
    const firstName =
      options.firstName ?? (await terminal.question('Prénom : '));
    const lastName = options.lastName ?? (await terminal.question('Nom : '));
    const role =
      options.role ??
      (await terminal.question('Rôle (admin ou super_admin) : '));

    return {
      phone,
      firstName,
      lastName,
      role: (role || UserRole.ADMIN) as AdminUserRole,
    };
  } finally {
    terminal.close();
  }
}

function readHiddenInput(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'La saisie du PIN exige un terminal interactif afin de ne pas exposer le secret',
    );
  }

  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();

  return new Promise((resolve, reject) => {
    let value = '';

    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };

    const onData = (chunk: string | Buffer) => {
      for (const character of String(chunk)) {
        if (character === '\u0003') {
          cleanup();
          reject(new Error('Création annulée'));
          return;
        }

        if (character === '\r' || character === '\n') {
          cleanup();
          resolve(value);
          return;
        }

        if (character === '\u0008' || character === '\u007f') {
          value = value.slice(0, -1);
          continue;
        }

        if (character >= ' ') {
          value += character;
        }
      }
    };

    process.stdin.on('data', onData);
  });
}

function maskPhone(phone: string): string {
  if (phone.length <= 6) {
    return '***';
  }

  return `${phone.slice(0, 4)}…${phone.slice(-2)}`;
}

async function main(): Promise<void> {
  const visibleInputs = await readVisibleInputs(readCliOptions());
  const password = await readHiddenInput(
    `Mot de passe ${visibleInputs.role} (8 a 128 caracteres) : `,
  );
  const passwordConfirmation = await readHiddenInput(
    'Confirmer le mot de passe : ',
  );

  if (password !== passwordConfirmation) {
    throw new Error('Les deux mots de passe ne correspondent pas');
  }

  await dataSource.initialize();
  try {
    const admin = await provisionAdminAccount(dataSource.getRepository(User), {
      ...visibleInputs,
      password,
    });
    const label =
      admin.role === UserRole.SUPER_ADMIN
        ? 'super administrateur'
        : 'administrateur';
    console.log(
      `Compte ${label} créé : ${admin.id} (${maskPhone(admin.phone)})`,
    );
  } finally {
    await dataSource.destroy();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Erreur inconnue';
  console.error(`Création du compte back-office impossible : ${message}`);
  process.exitCode = 1;
});
