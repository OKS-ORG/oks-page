// Four bars and a word under a new password, in the setup wizard and on the invitation page.

/** How strong a password looks to its owner: by length only, and the server still decides (at least 10 characters). */
function strength(password: string): { level: number; word: string } {
  if (password.length === 0) return { level: 0, word: "" };
  if (password.length < 10) return { level: 1, word: "Too short" };
  if (password.length < 14) return { level: 2, word: "Fine" };
  if (password.length < 18) return { level: 3, word: "Good" };
  return { level: 4, word: "Strong password" };
}

export function PasswordStrength({ password }: { password: string }) {
  const { level, word } = strength(password);
  return (
    <>
      <div className="oks-strength" data-level={level}>
        <span />
        <span />
        <span />
        <span />
      </div>
      <p className="oks-strength-word" role="status">
        {word}
      </p>
    </>
  );
}
