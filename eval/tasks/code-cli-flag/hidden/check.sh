set -e
cd "$SANDBOX"
printf 'b a c b a b\nzeta Zeta alpha\n' > /tmp/pico_eval_wc_$$.txt
F=/tmp/pico_eval_wc_$$.txt
trap 'rm -f $F' EXIT
[ "$(python3 wc.py $F)" = "9" ]
[ "$(python3 wc.py -l $F)" = "2" ]
[ "$(python3 wc.py --lines $F)" = "2" ]
out=$(python3 wc.py --top 3 $F)
exp=$(printf 'b 3\na 2\nzeta 2')
[ "$out" = "$exp" ] || { echo "got: $out"; exit 1; }
[ "$(python3 wc.py --top 1 sample.txt)" = "cat 3" ] || [ "$(python3 wc.py --top 1 sample.txt)" = "the 3" ]
out2=$(python3 wc.py --top 2 sample.txt); [ "$out2" = "$(printf 'cat 3\nthe 3')" ] || { echo "got2: $out2"; exit 1; }
echo ok
