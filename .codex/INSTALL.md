# Installing Code Factory for Codex

1. Clone the repository:
   ```bash
   git clone https://github.com/xmtplabs/code-factory.git
   ```

2. Create a symlink to make skills available:
   ```bash
   mkdir -p ~/.agents/skills
   ln -s "$(pwd)/skills" ~/.agents/skills/code-factory
   ```
