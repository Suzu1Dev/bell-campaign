class BellCampaign < Formula
  desc "Local-first weekly countdown timeline, team progress, and event operations workspace"
  homepage "https://github.com/Suzu1Dev/bell-campaign"
  url "https://github.com/Suzu1Dev/bell-campaign/archive/refs/heads/main.tar.gz"
  version "1.0.0"
  license "MIT"
  head "https://github.com/Suzu1Dev/bell-campaign.git", branch: "main"

  depends_on "node"
  depends_on "git"

  def install
    system "npm", "install", *std_npm_args(ignore_scripts: false)
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/bell-campaign --version")
    assert_match "doctor", shell_output("#{bin}/bell-campaign --help")
  end
end
