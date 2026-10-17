import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.UUID;

public class Epsilon {
private final ConcurrentHashMap<String, AtomicInteger> hits = new ConcurrentHashMap<>();

     public int hit(String key) {
  return hits.computeIfAbsent(key, k -> new AtomicInteger()).incrementAndGet();
        }

  public int total(){
        int sum = 0;
      for (AtomicInteger n : hits.values()) { sum += n.get(); }
            return sum;
    }
}
