#!/usr/bin/perl
# Test-only stand-in for codex, installed as <fake root>/bin/codex. `exec` never calls a model: it records the
# descriptor table and environment it inherited (before opening anything), its argv and its standard input, then
# prints the scripted event stream. Other subcommands go to the real codex, except `sandbox` in mode "open", which runs
# the probe command with no sandbox at all: the weakened-lane double.
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
exec { $real } $real, @ARGV or die "fake codex: real codex";
