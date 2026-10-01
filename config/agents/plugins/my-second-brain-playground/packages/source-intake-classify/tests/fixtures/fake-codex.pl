#!/usr/bin/perl
# Test-only stand-in for codex, installed as <fake root>/bin/codex. `exec` never calls a model: it records the
# descriptor table and environment it inherited (before opening anything), its argv and its standard input, then
# prints the scripted event stream. Other subcommands go to the real codex, except `sandbox` in mode "open", which runs
# the probe command with no sandbox at all: the weakened-lane double. Mode "slow-probe" marks probe-waiting and pauses
# before a sandboxed read of a receipt-named file, so a test can signal the command mid pre-flight. Mode
# "render-variant" adds an attribute to every rendered read entry, a permission format the pre-flight does not know.
use strict;
use warnings;
use POSIX ();
use File::Basename qw(dirname);
use JSON::PP ();

my @inherited;
for my $fd (0 .. 255) {
	my $copy = POSIX::dup($fd);
	next unless defined $copy;
	push @inherited, $fd;
	POSIX::close($copy);
}

my $root = dirname(dirname(__FILE__));
sub slurp { my ($path) = @_; open(my $in, "<", $path) or die "fake codex: $path"; local $/; my $text = <$in>; close $in; return $text }
sub spill { my ($path, $text) = @_; open(my $out, ">", $path) or die "fake codex: $path"; print $out $text; close $out }
my $mode = slurp("$root/mode");
my $real = slurp("$root/real-codex");
my $command = $ARGV[0] // "";

if ($command eq "exec") {
	# Marks the start before reading standard input, so a run killed mid-input still shows that a model process began.
	spill("$root/exec-started", "started");
	my $count = 0;
	$count++ while -e "$root/exec-$count.json";
	local $/;
	my $stdin = <STDIN> // "";
	spill("$root/exec-$count.json", JSON::PP->new->canonical->encode({ descriptors => \@inherited, env => \%ENV, argv => \@ARGV, stdin => $stdin }));
	print slurp("$root/events.jsonl");
	exit(0 + slurp("$root/exit-code"));
}
if ($command eq "sandbox" && $mode eq "open") {
	shift @ARGV while @ARGV && $ARGV[0] ne "--";
	shift @ARGV;
	exec { $ARGV[0] } @ARGV or die "fake codex: open probe";
}
if ($command eq "sandbox" && $mode eq "slow-probe" && ($ARGV[-1] // "") =~ /classification-metadata\.json$/) {
	spill("$root/probe-waiting", "waiting");
	sleep 3;
}
if ($command eq "debug" && $mode eq "render-variant") {
	open(my $render, "-|", $real, @ARGV) or die "fake codex: render";
	local $/;
	my $text = <$render> // "";
	close $render;
	$text =~ s/<entry access=\\"read\\"><path>/<entry access=\\"read\\" scope=\\"subtree\\"><path>/g;
	print $text;
	exit($? >> 8);
}
exec { $real } $real, @ARGV or die "fake codex: real codex";
