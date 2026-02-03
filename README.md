# ZSH-Config

This are the files to configure properly zsh on my mac.

## Dependencies
- oh-my-zsh: get the last version [here](https://ohmyz.sh/).
- Plugins for oh-my-zsh: 
  - git: included already with oh-my-zsh
  - timer: included already with oh-my-zsh
  - thefuck: brew install the fuck
  - zsh-autosuggestions: git clone https://github.com/zsh-users/zsh-autosuggestions.git
  - zsh-syntax-highlighting: git clone https://github.com/zsh-users/zsh-syntax-highlighting.git
- neovim: brew install neovim
- lazy vim: get the last version [here](https://www.lazyvim.org/)
- fzf: brew install fzf.
- Some random terminal that supports nerd-fonts, like [Alacritty](https://alacritty.org/) or [ghostty](https://ghostty.org/).

## Files included:
- .zshrc with already configured subfiles divisions
- oh-my-zsh-config.sh: main config for oh-my-zsh. It is mostly vanilla right now, may change in the future.
- custom-config.sh: some exported variables and utility functions
- zara-custom-config.sh: some exported variables and utility functions for zara. They might have more dependencies that won't be covered here.
- golden-wishdom.sh: a custom welcome message for when a new terminal or session is opened.

## Where does this files go
This files should be put on your home folder (~) and overwrite your currect .zshrc file. Also, .zsh-config folder should be put on your home directory as well.

You can clone this project and execute a mv command to move everything to there:

**WARNING!** before executing anything, make a backup of your current configuration. Be warned it will be lost forever.

**WARNING!** NEVER execute commands found randomly on internet. Go to the source and execute their given commands. Be warned, any random link found on internet could contain malware. The following commands are a demostration of the proccess on which we are going to download and configure everything in order for this repo to work.

```bash
# OhMyZSH dependencies
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"

cd ~/.oh-my-zsh/custom/plugins
git clone https://github.com/zsh-users/zsh-autosuggestions.git
git clone https://github.com/zsh-users/zsh-syntax-highlighting.git

# We go back to home
cd ~

# We install neovim and other dependencies
brew install neovim

# required
mv ~/.config/nvim{,.bak}

# optional but recommended
mv ~/.local/share/nvim{,.bak}
mv ~/.local/state/nvim{,.bak}
mv ~/.cache/nvim{,.bak}

git clone https://github.com/LazyVim/starter ~/.config/nvim
rm -rf ~/.config/nvim/.git

# Other dependencies for zsh
brew install thefuck
brew install fzf

# We clone this repo and move things around
git clone https://github.com/candradesm/zsh-config
rm -rf zsh-config/.git
rm -rf zsh-config/README.md zsh-config/staitc
mv zsh-config/* ~/

# Finally, set down everything
source .zshrc
```

## How does it look
```bash
Last login: Tue Feb  3 18:00:48 on ttys004

🐵 JUNIOR MONKE WISDOM FROM THE PROPHECY 🍌
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Never assume you know everything. Ask questions when uncertain. 🤝
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
For the Golden Bananzas! ☀️🍌✨

➜  zsh-config git:(main) ✗
````
![](./static/image.png)
