import java.util.Iterator;
import java.util.BitSet;
import java.util.Random;
import java.util.NoSuchElementException;
import java.util.Calendar;
import java.text.SimpleDateFormat;

public class Zeta implements Iterable<Integer> {
    private final BitSet bits = new BitSet();

        public void set(int index){ bits.set(index); }

  @Override
      public Iterator<Integer> iterator() {
    return new Iterator<Integer>() {
            private int next = bits.nextSetBit(0);
      public boolean hasNext() { return next >= 0; }
        public Integer next() {
  if (next < 0) throw new NoSuchElementException();
                int current = next;
          next = bits.nextSetBit(next + 1);
      return current;
            }
    };
}
}
