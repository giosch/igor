class Igor < Formula
  desc "Delegate local coding tasks and review the resulting Git patches"
  homepage "https://github.com/giosch/igor"
  url "https://github.com/giosch/igor/archive/refs/tags/v0.1.2.tar.gz"
  sha256 "d7da7c8553e88664193630d07544e54785af6b66cac9a62c60643cb3c2dcc2ed"
  license "MIT"

  depends_on "git"
  depends_on "node@24"

  resource "pi" do
    url "https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-1.6.0.tgz"
    sha256 "85d5de404e019e850c90ee9ac6dc6c16240da122fdce0314895608164030336b"
  end

  def install
    libexec.install %w[src docs examples scripts skills tests package.json package-lock.json README.md LICENSE]
    pi = libexec/"node_modules/@earendil-works/pi-coding-agent"
    resource("pi").stage { pi.install Dir["*"] }
    (libexec/"bin").install_symlink pi/"dist/bundle/cli.js" => "pi"
    (bin/"igor").write_env_script libexec/"src/cli/index.js",
      PATH: "#{Formula["node@24"].opt_bin}:#{Formula["git"].opt_bin}:#{libexec}/bin:#{HOMEBREW_PREFIX}/opt/omlx/bin:$PATH"
  end

  def caveats
    <<~EOS
      To run Igor's default model on Apple Silicon, install the oMLX server and download the weights:
        brew bundle --file="$(brew --repository giosch/igor)/Brewfile"
        igor model download inkling-mini
        igor start
    EOS
  end

  test do
    ENV["IGOR_HOME"] = (testpath/"state").to_s
    (testpath/"project").mkpath
    (testpath/"project/input.txt").write "Hello from Homebrew\n"
    assert_equal version.to_s, shell_output("#{bin}/igor --version").strip
    system bin/"igor", "run", "--model", "mock", "--code", "project", "--prompt", "hello", "--json"
    jobs = JSON.parse(shell_output("#{bin}/igor list --json")).fetch("jobs")
    assert_equal 1, jobs.length
    job = JSON.parse(shell_output("#{bin}/igor result #{jobs.first.fetch("jobId")} --json"))
    assert_equal "completed", job.fetch("status")
    assert_equal ["igor-task.md"], job.fetch("filesChanged")
    assert_match "diff --git a/igor-task.md b/igor-task.md", shell_output("#{bin}/igor diff #{job.fetch("jobId")}")
    refute_path_exists testpath/"project/igor-task.md"
  ensure
    system bin/"igor", "stop"
  end
end
