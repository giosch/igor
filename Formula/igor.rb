class Igor < Formula
  desc "Delegate local coding tasks and review the resulting Git patches"
  homepage "https://github.com/giosch/igor"
  url "https://github.com/giosch/igor/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "54c34ee9aa823c746b0ba7c5587d39f6f542613514aff6889e47134e2da7e9b1"
  license "MIT"

  depends_on "git"
  depends_on "node@24"

  def install
    inreplace "src/cli/index.js", "#!/usr/bin/env node", "#!#{Formula["node@24"].opt_bin}/node"
    libexec.install %w[src docs examples scripts skills tests package.json package-lock.json README.md LICENSE]
    bin.install_symlink libexec/"src/cli/index.js" => "igor"
  end

  test do
    ENV["IGOR_HOME"] = (testpath/"state").to_s
    (testpath/"project").mkpath
    (testpath/"project/input.txt").write "Hello from Homebrew\n"
    assert_equal version.to_s, shell_output("#{bin}/igor --version").strip
    job = JSON.parse(shell_output("#{bin}/igor run --model mock --code project --prompt hello --json"))
    assert_equal "completed", job.fetch("status")
    assert_equal ["igor-task.md"], job.fetch("filesChanged")
    assert_match "diff --git a/igor-task.md b/igor-task.md", shell_output("#{bin}/igor diff #{job.fetch("jobId")}")
    refute_path_exists testpath/"project/igor-task.md"
  ensure
    system bin/"igor", "stop"
  end
end
