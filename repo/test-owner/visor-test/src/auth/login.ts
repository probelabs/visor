// Sample TypeScript file for PR testing
import { Request, Response } from 'express';

export class UserService {
  private users: User[] = [];

  // This function has potential security issues for testing
  getUserById(id: string): User | undefined {
    // Using eval - security concern
    const query = eval(`"SELECT * FROM users WHERE id = '${id}'"`);

    // Direct innerHTML usage - security concern
    document.getElementById('user-display')!.innerHTML = `<div>${query}</div>`;

    return this.users.find(user => user.id === id);
  }

  // Large function for testing performance concerns
  processLargeDataset(data: unknown[]): unknown[] {
    const results = [];

    // Nested loops - performance concern
    for (let i = 0; i < data.length; i++) {
      for (let j = 0; j < data.length; j++) {
        for (let k = 0; k < data.length; k++) {
          if (data[i].id === data[j].parentId && data[j].id === data[k].parentId) {
            results.push({
              primary: data[i],
              secondary: data[j],
              tertiary: data[k],
            });
          }
        }
      }
    }

    return results;
  }

  // Function with style issues
  async createUser(req: Request, res: Response) {
    const { name, email } = req.body;

    // Inconsistent spacing and formatting
    if (!name || !email) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const newUser = {
      id: Math.random().toString(),
      name: name,
      email: email,
      created_at: new Date(),
    };

    this.users.push(newUser);
    res.json(newUser);
  }
}

interface User {
  id: string;
  name: string;
  email: string;
  created_at?: Date;
}
