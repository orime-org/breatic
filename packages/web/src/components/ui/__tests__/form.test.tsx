import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';

const schema = z.object({
  email: z.string().email('Invalid email'),
});

type Schema = z.infer<typeof schema>;

function Harness({ onSubmit = () => {} }: { onSubmit?: (v: Schema) => void }) {
  const form = useForm<Schema>({
    resolver: zodResolver(schema),
    defaultValues: { email: '' },
    mode: 'onSubmit',
  });
  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <FormField
          control={form.control}
          name='email'
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email address</FormLabel>
              <FormControl>
                <Input data-testid='email-input' {...field} />
              </FormControl>
              <FormDescription>We will not share it.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <button type='submit'>Submit</button>
      </form>
    </Form>
  );
}

describe('Form', () => {
  it('renders Label / Input / Description wired together', () => {
    render(<Harness />);
    expect(screen.getByText('Email address')).toBeInTheDocument();
    expect(screen.getByTestId('email-input')).toBeInTheDocument();
    expect(screen.getByText('We will not share it.')).toBeInTheDocument();
  });

  it('Label htmlFor matches Input id (FormItem useId wiring)', () => {
    render(<Harness />);
    const label = screen.getByText('Email address');
    const input = screen.getByTestId('email-input');
    expect(label.getAttribute('for')).toBe(input.getAttribute('id'));
  });

  it('Input aria-describedby includes description id (no error state)', () => {
    render(<Harness />);
    const input = screen.getByTestId('email-input');
    const description = screen.getByText('We will not share it.');
    expect(input.getAttribute('aria-describedby')).toContain(
      description.getAttribute('id') as string,
    );
    expect(input.getAttribute('aria-invalid')).toBe('false');
  });

  it('submit with invalid value renders FormMessage + aria-invalid=true', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByTestId('email-input');
    await user.type(input, 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Invalid email')).toBeInTheDocument();
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('submit with valid value calls onSubmit with parsed data', async () => {
    const user = userEvent.setup();
    let submitted: Schema | null = null;
    render(
      <Harness
        onSubmit={(v) => {
          submitted = v;
        }}
      />,
    );
    await user.type(screen.getByTestId('email-input'), 'a@b.com');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(submitted).toEqual({ email: 'a@b.com' });
  });
});
